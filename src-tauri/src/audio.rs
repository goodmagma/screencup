//! Audio capture for screen recordings: the default microphone and the system output
//! (WASAPI loopback: an input stream opened on the output device). Each source is written
//! to its own 32-bit float WAV while the video records; the recorder muxes them in on stop.
//!
//! Loopback delivers no data while nothing plays, and devices can stall, so the writer
//! keeps the WAV in step with the wall clock by inserting silence whenever the stream falls
//! behind. That keeps the audio aligned with the video over long recordings.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};

#[derive(Clone, Copy, Debug)]
pub enum Source {
    Microphone,
    System,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Microphone => "microphone",
            Source::System => "system audio",
        }
    }
}

/// How far the WAV may trail the wall clock before silence is inserted. Larger than the
/// usual device buffering, so steady streams are never padded.
const MAX_LAG: Duration = Duration::from_millis(150);
const POLL: Duration = Duration::from_millis(100);

/// A running capture; [`AudioCapture::finish`] stops it and returns the finished WAV.
pub struct AudioCapture {
    pub source: Source,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<Result<PathBuf, String>>,
}

impl AudioCapture {
    /// Starts capturing `source` into `path`; fails if the device cannot be opened.
    pub fn start(source: Source, path: PathBuf) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();
        let stop_flag = stop.clone();
        // cpal streams are not `Send` on every platform, so one thread owns stream and writer.
        let thread = std::thread::spawn(move || run(source, path, stop_flag, ready_tx));
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(AudioCapture { source, stop, thread }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(thread
                .join()
                .map_or_else(|_| "audio thread panicked".into(), |r| r.err().unwrap_or_default())),
        }
    }

    /// Signals the capture to stop without waiting; [`AudioCapture::finish`] then joins it.
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    pub fn finish(self) -> Result<PathBuf, String> {
        self.request_stop();
        self.thread.join().map_err(|_| "audio thread panicked".to_string())?
    }
}

fn run(
    source: Source,
    path: PathBuf,
    stop: Arc<AtomicBool>,
    ready: mpsc::Sender<Result<(), String>>,
) -> Result<PathBuf, String> {
    let (stream, rx, channels, rate) = match open(source) {
        Ok(opened) => opened,
        Err(e) => {
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }
    };
    let spec = hound::WavSpec {
        channels,
        sample_rate: rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = match hound::WavWriter::create(&path, spec) {
        Ok(w) => w,
        Err(e) => {
            let e = format!("{}: {e}", path.display());
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }
    };
    let _ = ready.send(Ok(()));

    let started = Instant::now();
    let per_second = rate as f64 * channels as f64;
    let max_lag = (MAX_LAG.as_secs_f64() * per_second) as u64;
    // Samples (all channels) the WAV should hold `elapsed` after the start.
    let expected = |elapsed: Duration| {
        let n = (elapsed.as_secs_f64() * per_second) as u64;
        n - n % channels as u64
    };
    let mut written: u64 = 0;
    let pad = |writer: &mut hound::WavWriter<_>, written: &mut u64, upto: u64| -> Result<(), String> {
        while *written < upto {
            writer.write_sample(0.0f32).map_err(|e| e.to_string())?;
            *written += 1;
        }
        Ok(())
    };

    while !stop.load(Ordering::SeqCst) {
        match rx.recv_timeout(POLL) {
            Ok(chunk) => {
                let target = expected(started.elapsed()).saturating_sub(chunk.len() as u64);
                if written + max_lag < target {
                    pad(&mut writer, &mut written, target)?;
                }
                for s in &chunk {
                    writer.write_sample(*s).map_err(|e| e.to_string())?;
                }
                written += chunk.len() as u64;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let target = expected(started.elapsed()).saturating_sub(max_lag);
                if written < target {
                    pad(&mut writer, &mut written, target)?;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let end = started.elapsed();
    drop(stream);
    for chunk in rx.try_iter() {
        for s in &chunk {
            writer.write_sample(*s).map_err(|e| e.to_string())?;
        }
        written += chunk.len() as u64;
    }
    pad(&mut writer, &mut written, expected(end))?;
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(path)
}

type Opened = (cpal::Stream, mpsc::Receiver<Vec<f32>>, u16, u32);

fn open(source: Source) -> Result<Opened, String> {
    let host = cpal::default_host();
    let (device, supported) = match source {
        Source::Microphone => {
            let d = host.default_input_device().ok_or("no microphone found")?;
            let c = d.default_input_config().map_err(|e| e.to_string())?;
            (d, c)
        }
        Source::System => {
            if !cfg!(target_os = "windows") {
                return Err("system audio capture is only supported on Windows for now".into());
            }
            let d = host.default_output_device().ok_or("no audio output device found")?;
            let c = d.default_output_config().map_err(|e| e.to_string())?;
            (d, c)
        }
    };
    let config = supported.config();
    let (tx, rx) = mpsc::channel();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, config, tx),
        SampleFormat::I16 => build::<i16>(&device, config, tx),
        SampleFormat::I32 => build::<i32>(&device, config, tx),
        SampleFormat::U16 => build::<u16>(&device, config, tx),
        other => return Err(format!("unsupported sample format {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, rx, config.channels, config.sample_rate))
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    tx: mpsc::Sender<Vec<f32>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                let _ = tx.send(data.iter().map(|s| s.to_sample::<f32>()).collect());
            },
            |e| eprintln!("audio stream error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

/// Length of a WAV written by [`AudioCapture`], in seconds.
pub fn wav_seconds(path: &std::path::Path) -> Result<f64, String> {
    let reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    Ok(reader.duration() as f64 / reader.spec().sample_rate as f64)
}

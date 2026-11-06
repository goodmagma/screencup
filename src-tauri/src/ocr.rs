//! Text recognition: copies the text of a screenshot to the clipboard.
//!
//! Windows has an OCR engine built in (Windows.Media.Ocr). It reads the languages installed in
//! the user profile, so nothing is bundled with the app. Other systems report it as missing.

use tauri::AppHandle;

use crate::library;

/// Recognises the text of a capture (lines separated by newlines) and copies it to the
/// clipboard. Returns the text, empty when none was found.
#[tauri::command]
pub async fn ocr_capture(app: AppHandle, name: String) -> Result<String, String> {
    let path = library::resolve(&app, &name)?;
    if library::is_video(&path) {
        return Err(format!("{name}: not an image"));
    }
    let img = xcap::image::open(&path).map_err(|e| format!("{}: {e}", path.display()))?.to_rgba8();
    // WinRT wants a thread of its own with an initialised apartment.
    let text = std::thread::spawn(move || recognize(img)).join().map_err(|_| "OCR crashed".to_string())??;
    if !text.is_empty() {
        crate::clipboard::copy_text(&app, &text)?;
    }
    Ok(text)
}

#[cfg(windows)]
fn recognize(img: xcap::image::RgbaImage) -> Result<String, String> {
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
    use xcap::image::imageops::FilterType;

    let err = |e: windows::core::Error| e.message().to_string();
    // SAFETY: initialises WinRT for this new thread; an error means it already was.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "no OCR language installed in Windows".to_string())?;
    // The engine refuses larger images: scale down, keeping the aspect ratio.
    let max = OcrEngine::MaxImageDimension().map_err(err)?;
    let img = if img.width() > max || img.height() > max {
        let k = max as f64 / img.width().max(img.height()) as f64;
        let (w, h) = ((img.width() as f64 * k) as u32, (img.height() as f64 * k) as u32);
        xcap::image::imageops::resize(&img, w.max(1), h.max(1), FilterType::Triangle)
    } else {
        img
    };

    // RGBA to the BGRA layout SoftwareBitmap expects.
    let (w, h) = (img.width() as i32, img.height() as i32);
    let mut bgra = img.into_raw();
    for px in bgra.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
    let buffer = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(err)?;
    let bitmap =
        SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w, h).map_err(err)?;

    let result = engine.RecognizeAsync(&bitmap).map_err(err)?.join().map_err(err)?;
    let lines = result.Lines().map_err(err)?;
    let mut text = Vec::new();
    for line in lines {
        text.push(line.Text().map_err(err)?.to_string());
    }
    Ok(text.join("\n"))
}

#[cfg(not(windows))]
fn recognize(_img: xcap::image::RgbaImage) -> Result<String, String> {
    Err("text recognition is only available on Windows for now".into())
}

#[cfg(all(test, windows))]
mod tests {
    /// Manual check on a real image: `SCREENCUP_OCR_SAMPLE=<png> cargo test -p screencup ocr -- --ignored`.
    #[test]
    #[ignore]
    fn recognizes_sample() {
        let path = std::env::var("SCREENCUP_OCR_SAMPLE").expect("set SCREENCUP_OCR_SAMPLE");
        let img = xcap::image::open(path).unwrap().to_rgba8();
        let text = super::recognize(img).unwrap();
        println!("{text}");
        assert!(!text.trim().is_empty());
    }
}

//! "Save as…": writes a capture to a file of the user's choice as PNG, JPG or PDF. The
//! library keeps its PNG; the editor saves (flattens) before exporting.

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt as _;
use xcap::image::{DynamicImage, ImageFormat, RgbImage};

use crate::library;

/// Quality of exported JPEGs, also used for the image inside PDFs.
const JPEG_QUALITY: u8 = 92;

/// Asks where to save the capture, then converts it by the chosen extension. `None` when
/// the dialog was dismissed. Async: the dialog blocks until the user answers.
#[tauri::command]
pub async fn export_capture(app: AppHandle, name: String) -> Result<Option<PathBuf>, String> {
    let src = library::resolve(&app, &name)?;
    if library::is_video(&src) {
        return Err(format!("{name}: not an image"));
    }
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.clone());
    let picked = app
        .dialog()
        .file()
        .set_file_name(format!("{stem}.png"))
        .add_filter("PNG", &["png"])
        .add_filter("JPEG", &["jpg", "jpeg"])
        .add_filter("PDF", &["pdf"])
        .blocking_save_file();
    let Some(dest) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let img = xcap::image::open(&src).map_err(|e| format!("{}: {e}", src.display()))?;
    write(&img, &dest)?;
    Ok(Some(dest))
}

fn write(img: &DynamicImage, dest: &Path) -> Result<(), String> {
    let ext = dest.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let bytes = match ext.as_str() {
        "jpg" | "jpeg" => jpeg(img)?,
        "pdf" => pdf(img)?,
        // PNG, or no / unknown extension.
        _ => {
            let mut out = Vec::new();
            img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).map_err(|e| e.to_string())?;
            out
        }
    };
    std::fs::write(dest, bytes).map_err(|e| format!("{}: {e}", dest.display()))
}

/// JPEG has no transparency: transparent pixels become white.
fn jpeg(img: &DynamicImage) -> Result<Vec<u8>, String> {
    let rgba = img.to_rgba8();
    let rgb = RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let blend = |c: u8| ((c as u32 * a as u32 + 255 * (255 - a as u32)) / 255) as u8;
        xcap::image::Rgb([blend(r), blend(g), blend(b)])
    });
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode_image(&rgb).map_err(|e| e.to_string())?;
    Ok(out)
}

/// A one-page PDF holding the image as a JPEG, with the page sized to the image at 96 dpi.
fn pdf(img: &DynamicImage) -> Result<Vec<u8>, String> {
    let (w, h) = (img.width(), img.height());
    let data = jpeg(img)?;
    // 96 dpi screen pixels to 72 dpi PDF points.
    let (pw, ph) = (w as f64 * 0.75, h as f64 * 0.75);
    let content = format!("q {pw:.2} 0 0 {ph:.2} 0 0 cm /Im0 Do Q");

    let mut out: Vec<u8> = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::new();
    let mut object = |out: &mut Vec<u8>, head: String, stream: Option<&[u8]>| {
        offsets.push(out.len());
        let _ = write!(out, "{} 0 obj\n{head}\n", offsets.len());
        if let Some(bytes) = stream {
            out.extend_from_slice(b"stream\n");
            out.extend_from_slice(bytes);
            out.extend_from_slice(b"\nendstream\n");
        }
        out.extend_from_slice(b"endobj\n");
    };
    object(&mut out, "<< /Type /Catalog /Pages 2 0 R >>".into(), None);
    object(&mut out, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(), None);
    object(
        &mut out,
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw:.2} {ph:.2}] \
             /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"
        ),
        None,
    );
    object(
        &mut out,
        format!(
            "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB \
             /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>",
            data.len()
        ),
        Some(&data),
    );
    object(&mut out, format!("<< /Length {} >>", content.len()), Some(content.as_bytes()));

    let xref = out.len();
    let _ = write!(out, "xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1);
    for offset in &offsets {
        // Each xref entry is exactly 20 bytes, ending in space + newline.
        let _ = writeln!(out, "{offset:010} 00000 n ");
    }
    let _ = write!(out, "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", offsets.len() + 1);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_xref_points_at_objects() {
        let img = DynamicImage::ImageRgba8(xcap::image::RgbaImage::from_pixel(
            8,
            4,
            xcap::image::Rgba([10, 20, 30, 128]),
        ));
        let pdf = pdf(&img).unwrap();
        // Byte offsets: the JPEG stream is binary, so work on bytes, not text.
        let tail_at = pdf.windows(10).rposition(|w| w == b"startxref\n").unwrap() + 10;
        let tail = std::str::from_utf8(&pdf[tail_at..]).unwrap();
        let start: usize = tail.lines().next().unwrap().parse().unwrap();
        let xref = std::str::from_utf8(&pdf[start..]).unwrap();
        assert!(xref.starts_with("xref\n0 6\n"));
        for (i, line) in xref.lines().skip(3).take(5).enumerate() {
            assert_eq!(line.len(), 19, "entries are 20 bytes with the newline");
            let offset: usize = line[..10].parse().unwrap();
            assert!(pdf[offset..].starts_with(format!("{} 0 obj", i + 1).as_bytes()));
        }
        assert!(pdf.ends_with(b"%%EOF\n"));
    }

    #[test]
    fn jpeg_flattens_on_white() {
        let img = DynamicImage::ImageRgba8(xcap::image::RgbaImage::from_pixel(
            4,
            4,
            xcap::image::Rgba([0, 0, 0, 0]),
        ));
        let decoded = xcap::image::load_from_memory(&jpeg(&img).unwrap()).unwrap().to_rgb8();
        assert!(decoded.pixels().all(|p| p.0.iter().all(|&c| c > 245)));
    }
}

//! "Send by e-mail": opens a new message in the default mail client with the captures
//! attached.
//!
//! On Windows this goes through Simple MAPI (`MAPISendMailW`), which classic Outlook,
//! Thunderbird and most desktop clients support. When no client answers (none installed,
//! or one without MAPI such as the new Outlook), and on other systems, it falls back to a
//! `mailto:` message without attachment and shows the files in the file manager so they can
//! be dragged into it.

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::library;

/// How the message was prepared, for the gallery to tell the user.
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Sent {
    /// The mail client opened with the files attached (or the user closed it).
    #[cfg_attr(not(windows), allow(dead_code))] // Simple MAPI is Windows-only
    Attached,
    /// Fallback: a blank message plus the files shown in their folder.
    Manual,
}

/// Async: the MAPI call blocks until the compose window closes.
#[tauri::command]
pub async fn email_captures(app: AppHandle, names: Vec<String>) -> Result<Sent, String> {
    let paths = names.iter().map(|n| library::resolve(&app, n)).collect::<Result<Vec<_>, _>>()?;
    let subject = if names.len() == 1 { names[0].clone() } else { format!("Screencup ({})", names.len()) };

    #[cfg(windows)]
    {
        let (files, subj) = (paths.clone(), subject.clone());
        // MAPI wants its own thread (some clients need a fresh COM apartment).
        let attached = std::thread::spawn(move || mapi::send(&subj, &files))
            .join()
            .map_err(|_| "mail client crashed".to_string())?;
        match attached {
            Ok(()) => return Ok(Sent::Attached),
            Err(e) => eprintln!("MAPI: {e}"),
        }
    }

    manual(&app, &subject, &paths)?;
    Ok(Sent::Manual)
}

fn manual(app: &AppHandle, subject: &str, paths: &[PathBuf]) -> Result<(), String> {
    let subject: String =
        percent_encoding::utf8_percent_encode(subject, percent_encoding::NON_ALPHANUMERIC).to_string();
    app.opener().open_url(format!("mailto:?subject={subject}"), None::<&str>).map_err(|e| e.to_string())?;
    if let Some(first) = paths.first() {
        app.opener().reveal_item_in_dir(first).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
mod mapi {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::System::Mapi::{
        LPMAPISENDMAILW, MAPI_DIALOG, MAPI_LOGON_UI, MapiFileDescW, MapiMessageW,
    };

    /// MAPI result codes: success, and the user closing the message without sending.
    const SUCCESS: u32 = 0;
    const USER_ABORT: u32 = 1;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    fn wide_path(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain([0]).collect()
    }

    pub fn send(subject: &str, files: &[PathBuf]) -> Result<(), String> {
        // SAFETY: mapi32.dll is the system Simple MAPI stub; MAPISendMailW has the signature
        // of LPMAPISENDMAILW. Every string buffer outlives the call.
        unsafe {
            let dll = LoadLibraryW(wide("mapi32.dll").as_ptr());
            if dll.is_null() {
                return Err("mapi32.dll not found".into());
            }
            let Some(proc) = GetProcAddress(dll, c"MAPISendMailW".as_ptr().cast()) else {
                return Err("MAPISendMailW not found".into());
            };
            type SendMail = unsafe extern "system" fn(usize, usize, *const MapiMessageW, u32, u32) -> u32;
            // The same signature as windows-sys' LPMAPISENDMAILW.
            let _: LPMAPISENDMAILW = None::<SendMail>;
            let send_mail = std::mem::transmute::<unsafe extern "system" fn() -> isize, SendMail>(proc);

            let mut subject = wide(subject);
            let mut paths: Vec<Vec<u16>> = files.iter().map(|p| wide_path(p)).collect();
            let mut names: Vec<Vec<u16>> = files
                .iter()
                .map(|p| wide(&p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
                .collect();
            let mut descs: Vec<MapiFileDescW> = paths
                .iter_mut()
                .zip(names.iter_mut())
                .map(|(path, name)| MapiFileDescW {
                    // u32::MAX: no position, the client places the attachments.
                    nPosition: u32::MAX,
                    lpszPathName: path.as_mut_ptr(),
                    lpszFileName: name.as_mut_ptr(),
                    ..Default::default()
                })
                .collect();
            let message = MapiMessageW {
                lpszSubject: subject.as_mut_ptr(),
                nFileCount: descs.len() as u32,
                lpFiles: descs.as_mut_ptr(),
                ..Default::default()
            };
            match send_mail(0, 0, &message, MAPI_DIALOG | MAPI_LOGON_UI, 0) {
                SUCCESS | USER_ABORT => Ok(()),
                code => Err(format!("MAPISendMailW returned {code}")),
            }
        }
    }
}

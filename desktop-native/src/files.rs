use std::{collections::HashSet, fs::OpenOptions, io::Write, path::PathBuf, sync::Mutex};
use tauri::Manager;

#[derive(Default)]
pub struct DownloadedFiles(Mutex<HashSet<PathBuf>>);

#[tauri::command]
pub fn save_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, DownloadedFiles>,
    name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let name = PathBuf::from(&name);
    let name = name
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .ok_or("Invalid filename")?;
    let directory = app.path().download_dir().map_err(|e| e.to_string())?;
    for index in 0..10000 {
        let path = directory.join(if index == 0 {
            name.to_string()
        } else {
            let file = PathBuf::from(name);
            let stem = file.file_stem().unwrap().to_string_lossy();
            let extension = file
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            format!("{stem} ({index}){extension}")
        });
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(&bytes) {
                    let _ = std::fs::remove_file(&path);
                    return Err(error.to_string());
                }
                state
                    .0
                    .lock()
                    .map_err(|_| "Download lock poisoned")?
                    .insert(path.clone());
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Too many files with this name".into())
}

#[tauri::command]
pub fn open_download(state: tauri::State<'_, DownloadedFiles>, path: String) -> Result<(), String> {
    if !state
        .0
        .lock()
        .map_err(|_| "Download lock poisoned")?
        .contains(&PathBuf::from(&path))
    {
        return Err("Unknown download".into());
    }
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(&path).status();
    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open").arg(&path).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(&path)
        .status();
    let status = status.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Unable to open file".into())
    }
}

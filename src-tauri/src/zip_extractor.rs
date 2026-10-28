use std::fs::{self, File};
use std::io::{self, Cursor};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use zip::ZipArchive;

/// Verifies if a file is a valid multitrack audio format
pub fn is_audio_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "wav" | "wave" | "mp3" | "m4a" | "aac" | "ogg" | "flac" | "aif" | "aiff"
    )
}

/// Helper to sanitize Windows paths without UNC \\?\ prefix
fn clean_path_str(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if s.starts_with(r"\\?\") {
        s[4..].to_string()
    } else {
        s
    }
}

/// Helper: internal extraction routine for any Read + Seek archive reader
fn extract_archive<R: io::Read + io::Seek>(
    reader: R,
    target_dir: &Path,
) -> Result<Vec<String>, String> {
    fs::create_dir_all(target_dir).map_err(|e| format!("Falha ao criar pasta de destino: {}", e))?;

    let mut archive = ZipArchive::new(reader).map_err(|e| format!("Falha ao ler ZIP: {}", e))?;
    let mut audio_paths: Vec<String> = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Erro ao descompactar entrada {} do ZIP: {}", i, e))?;

        if file.is_dir() {
            continue;
        }

        let enclosed = match file.enclosed_name() {
            Some(path) => path.to_owned(),
            None => continue,
        };

        let file_name_str = enclosed.to_string_lossy();
        if file_name_str.contains("__MACOSX")
            || enclosed
                .file_name()
                .map(|n| n.to_string_lossy().starts_with('.'))
                .unwrap_or(false)
        {
            continue;
        }

        let out_path = target_dir.join(&enclosed);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Falha ao criar subdiretório: {}", e))?;
        }

        let mut out_file = File::create(&out_path)
            .map_err(|e| format!("Falha ao criar arquivo de áudio {:?}: {}", out_path, e))?;
        io::copy(&mut file, &mut out_file)
            .map_err(|e| format!("Falha ao extrair dados para {:?}: {}", out_path, e))?;

        if is_audio_file(&out_path) {
            let abs_path = out_path
                .canonicalize()
                .map(|p| clean_path_str(&p))
                .unwrap_or_else(|_| clean_path_str(&out_path));
            audio_paths.push(abs_path);
        }
    }

    // Sort paths alphabetically so stems are in predictable order
    audio_paths.sort();

    Ok(audio_paths)
}

/// Extrai um arquivo .zip a partir de seu caminho no disco local
#[tauri::command]
pub fn extract_multitrack_zip(zip_path: String) -> Result<Vec<String>, String> {
    let path = Path::new(&zip_path);
    if !path.exists() {
        return Err(format!("Arquivo ZIP não encontrado: {}", zip_path));
    }

    let file_stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("multitrack");

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let folder_name = format!("{}_{}", file_stem, timestamp);
    let target_dir = std::env::temp_dir()
        .join("worship_playback_pro")
        .join("multitracks_extracted")
        .join(folder_name);

    let file = File::open(path).map_err(|e| format!("Não foi possível abrir o ZIP: {}", e))?;
    extract_archive(file, &target_dir)
}

/// Extrai um arquivo .zip recebido diretamente em bytes (ex: download do Google Drive)
#[tauri::command]
pub fn extract_multitrack_zip_bytes(
    zip_bytes: Vec<u8>,
    zip_name: Option<String>,
) -> Result<Vec<String>, String> {
    let file_stem = zip_name
        .as_deref()
        .and_then(|n| Path::new(n).file_stem().and_then(|s| s.to_str()))
        .unwrap_or("multitrack_download");

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let folder_name = format!("{}_{}", file_stem, timestamp);
    let target_dir = std::env::temp_dir()
        .join("worship_playback_pro")
        .join("multitracks_extracted")
        .join(folder_name);

    let cursor = Cursor::new(zip_bytes);
    extract_archive(cursor, &target_dir)
}

/// Lê os bytes de um arquivo de áudio extraído no disco
#[tauri::command]
pub fn read_audio_file(file_path: String) -> Result<Vec<u8>, String> {
    fs::read(&file_path).map_err(|e| format!("Falha ao ler arquivo de áudio {}: {}", file_path, e))
}

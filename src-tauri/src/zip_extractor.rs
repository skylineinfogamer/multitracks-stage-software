use std::fs::{self, File};
use std::io::{self, Cursor, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::ZipArchive;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Verifies if a file is a valid multitrack audio format
pub fn is_audio_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "wav"
            | "wave"
            | "mp3"
            | "m4a"
            | "mp4"
            | "aac"
            | "ogg"
            | "flac"
            | "aif"
            | "aiff"
            | "wma"
            | "alac"
            | "caf"
            | "opus"
            | "webm"
            | "weba"
    )
}

/// Helper to sanitize Windows paths without UNC \\?\ or \\?\UNC\ prefix
pub fn clean_path_str(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if s.starts_with(r"\\?\UNC\") {
        format!(r"\\{}", &s[8..])
    } else if s.starts_with(r"\\?\") {
        s[4..].to_string()
    } else {
        s
    }
}

/// Varredura recursiva de arquivos de áudio em qualquer subpasta (ex: pasta_destino/Abertura Morada/*.wav)
/// Ignora pastas e arquivos ocultos do macOS (__MACOSX, ._*) e arquivos com 0 bytes.
pub fn find_audio_files_recursively(dir: &Path) -> Vec<String> {
    let mut results = Vec::new();
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current_dir) = stack.pop() {
        if let Ok(entries) = fs::read_dir(&current_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let file_name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                // Ignora exclusivamente metadados do macOS e arquivos de lixo
                if file_name.starts_with("._") || file_name == "__MACOSX" || file_name == ".DS_Store" {
                    continue;
                }

                if path.is_dir() {
                    stack.push(path);
                } else if path.is_file() && is_audio_file(&path) {
                    if let Ok(meta) = path.metadata() {
                        if meta.len() < 100 {
                            continue;
                        }
                    }
                    results.push(clean_path_str(&path));
                }
            }
        }
    }

    results.sort();
    results
}

#[cfg(target_os = "windows")]
pub fn extract_with_tar(zip_path: &Path, target_dir: &Path) -> Result<(), String> {
    println!("[EXTRACT] Executando descompactação nativa ultra-rápida via tar.exe...");
    let mut cmd = std::process::Command::new("tar.exe");
    cmd.args(["-xf", &zip_path.to_string_lossy(), "-C", &target_dir.to_string_lossy()]);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = cmd.output().map_err(|e| format!("Falha ao invocar tar.exe: {}", e))?;
    if !output.status.success() {
        let err_str = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tar.exe retornou código {:?}: {}", output.status.code(), err_str));
    }
    println!("[EXTRACT] tar.exe concluiu a descompactação com sucesso.");
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn extract_with_powershell(zip_path: &Path, target_dir: &Path) -> Result<(), String> {
    println!("[EXTRACT] Executando descompactação fallback via PowerShell Expand-Archive...");
    let mut cmd = std::process::Command::new("powershell.exe");
    let script = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        zip_path.to_string_lossy().replace('\'', "''"),
        target_dir.to_string_lossy().replace('\'', "''")
    );
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = cmd.output().map_err(|e| format!("Falha ao invocar PowerShell: {}", e))?;
    if !output.status.success() {
        let err_str = String::from_utf8_lossy(&output.stderr);
        return Err(format!("PowerShell retornou código {:?}: {}", output.status.code(), err_str));
    }
    println!("[EXTRACT] PowerShell concluiu a descompactação com sucesso.");
    Ok(())
}

/// Sanitizes a zip entry filename:
/// 1. Fallback decodes Windows-1252 / ISO-8859-1 for accented characters (e.g. ã, é, ó, ç).
/// 2. Normalizes Windows backslashes (\) to forward slashes (/).
/// 3. Strips drive letters and leading dots/slashes.
/// 4. Converts to a clean, safe relative path preventing path traversal (Zip Slip).
pub fn sanitize_and_resolve_entry(
    name_str: &str,
    raw_bytes: &[u8],
    index: usize,
) -> Option<PathBuf> {
    // 1. Character decoding with Portuguese/Spanish Windows-1252 fallback
    let decoded = if name_str.contains('\u{FFFD}') {
        raw_bytes.iter().map(|&b| b as char).collect::<String>()
    } else {
        name_str.to_string()
    };

    // 2. Normalize Windows backslashes to forward slashes
    let normalized = decoded.replace('\\', "/");

    // 3. Strip Windows drive letters (e.g. "C:/..." or "D:/...")
    let stripped = if let Some(colon) = normalized.find(':') {
        if colon < 3 {
            &normalized[colon + 1..]
        } else {
            &normalized
        }
    } else {
        &normalized
    };

    // 4. Strip leading slashes and relative indicators
    let trimmed = stripped.trim_start_matches(|c| c == '.' || c == '/');

    // 5. Build safe relative components, filtering out any empty or '..' components
    let components: Vec<&str> = trimmed
        .split('/')
        .filter(|comp| !comp.is_empty() && *comp != "." && *comp != "..")
        .collect();

    if components.is_empty() {
        return None;
    }

    // 6. Check for macOS metadata and hidden files
    if components.iter().any(|c| c.contains("__MACOSX")) {
        return None;
    }

    let file_name = components.last().copied().unwrap_or_default();
    // Only skip AppleDouble resource forks and OS hidden junk (e.g. ._*, .DS_Store, Thumbs.db)
    if file_name.starts_with("._") || file_name == ".DS_Store" || file_name.eq_ignore_ascii_case("thumbs.db") {
        return None;
    }

    let mut path = PathBuf::new();
    for comp in components {
        path.push(comp);
    }

    if path.as_os_str().is_empty() {
        Some(PathBuf::from(format!("track_{}.wav", index + 1)))
    } else {
        Some(path)
    }
}

/// Internal streaming extraction routine with 512KB chunk buffers
fn extract_archive<R: io::Read + io::Seek>(
    reader: R,
    target_dir: &Path,
) -> Result<Vec<String>, String> {
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("Falha ao criar pasta de destino: {}", e))?;

    let buf_reader = io::BufReader::with_capacity(512 * 1024, reader);
    let mut archive =
        ZipArchive::new(buf_reader).map_err(|e| format!("Falha ao inicializar ZipArchive: {}", e))?;

    let total_entries = archive.len();
    println!(
        "[ZIP] Descompactando via crate zip: {} entradas encontradas no ZIP...",
        total_entries
    );

    for i in 0..total_entries {
        let mut file = match archive.by_index(i) {
            Ok(f) => f,
            Err(e) => {
                eprintln!(
                    "[ZIP-WARN] Entrada {}/{} inacessível no ZIP: {}. Ignorando...",
                    i + 1,
                    total_entries,
                    e
                );
                continue;
            }
        };

        if file.is_dir() {
            continue;
        }

        // Resolves Windows vs Unix paths, accents (ã, õ, é, ç), and prevents Zip Slip
        let safe_relative = match sanitize_and_resolve_entry(file.name(), file.name_raw(), i) {
            Some(p) => p,
            None => {
                continue;
            }
        };

        let out_path = target_dir.join(&safe_relative);

        // Ensure parent directories exist
        if let Some(parent) = out_path.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                eprintln!(
                    "[ZIP-WARN] Falha ao criar pasta pai {:?} ({}/{}): {}. Ignorando...",
                    parent,
                    i + 1,
                    total_entries,
                    e
                );
                continue;
            }
        }

        let out_file = match File::create(&out_path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!(
                    "[ZIP-WARN] Falha ao criar arquivo no disco {:?} ({}/{}): {}. Ignorando...",
                    out_path,
                    i + 1,
                    total_entries,
                    e
                );
                continue;
            }
        };

        let mut out_writer = io::BufWriter::with_capacity(512 * 1024, out_file);
        let _ = io::copy(&mut file, &mut out_writer);
        let _ = out_writer.flush();
    }

    Ok(find_audio_files_recursively(target_dir))
}

/// Extração síncrona ultra-resiliente no Windows
pub fn extract_multitrack_zip_sync(zip_path: &str) -> Result<Vec<String>, String> {
    println!("[EXTRACT] ========================================================");
    println!("[EXTRACT] Iniciando descompactação nativa para: {}", zip_path);

    let path = Path::new(zip_path);
    if !path.exists() {
        let err = format!("Arquivo ZIP não encontrado: {}", zip_path);
        eprintln!("[EXTRACT-ERROR] Motivo detalhado: {}", err);
        return Err(err);
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

    if let Err(e) = fs::create_dir_all(&target_dir) {
        let err = format!("Falha ao criar diretório de destino {:?}: {}", target_dir, e);
        eprintln!("[EXTRACT-ERROR] Motivo detalhado: {}", err);
        return Err(err);
    }

    let mut extraction_ok = false;

    // 1. Método primário: crate zip em streaming
    println!("[EXTRACT] Método 1: Tentando descompactação via crate zip (Rust)...");
    match File::open(path) {
        Ok(file) => {
            match extract_archive(file, &target_dir) {
                Ok(files) if !files.is_empty() => {
                    println!("[EXTRACT] Crate zip extraiu {} arquivos de áudio válidos.", files.len());
                    extraction_ok = true;
                }
                Ok(_) => {
                    eprintln!("[EXTRACT] Crate zip não detectou arquivos no topo. Verificando subdiretórios...");
                }
                Err(e) => {
                    eprintln!("[EXTRACT-ERROR] Motivo detalhado (crate zip): {}. Tentando fallback nativo do Windows...", e);
                }
            }
        }
        Err(e) => {
            eprintln!("[EXTRACT-ERROR] Não foi possível abrir arquivo ZIP para leitura: {}. Tentando fallback...", e);
        }
    }

    // 2. Se a crate zip falhou ou não extraiu arquivos de áudio, usa tar.exe nativo do Windows 10/11
    #[cfg(target_os = "windows")]
    if !extraction_ok {
        println!("[EXTRACT] Método 2: Tentando descompactação via tar.exe nativo do Windows...");
        match extract_with_tar(path, &target_dir) {
            Ok(_) => {
                println!("[EXTRACT] tar.exe descompactou com sucesso.");
                extraction_ok = true;
            }
            Err(e) => {
                eprintln!("[EXTRACT-ERROR] Motivo detalhado (tar.exe): {}. Tentando PowerShell...", e);
            }
        }
    }

    // 3. Fallback 3: PowerShell Expand-Archive
    #[cfg(target_os = "windows")]
    if !extraction_ok {
        println!("[EXTRACT] Método 3: Tentando descompactação via PowerShell Expand-Archive...");
        match extract_with_powershell(path, &target_dir) {
            Ok(_) => {
                println!("[EXTRACT] PowerShell descompactou com sucesso.");
                let _ = extraction_ok;
            }
            Err(e) => {
                eprintln!("[EXTRACT-ERROR] Motivo detalhado (PowerShell): {}", e);
            }
        }
    }

    // 4. Varredura recursiva de áudio (resolve subpastas e acentos)
    println!("[EXTRACT] Executando varredura recursiva de áudio em {:?}...", target_dir);
    let audio_files = find_audio_files_recursively(&target_dir);

    if audio_files.is_empty() {
        let err = format!(
            "Nenhum arquivo de áudio válido (.wav, .mp3, .m4a, etc.) foi encontrado após extrair: {}",
            zip_path
        );
        eprintln!("[EXTRACT-ERROR] Motivo detalhado: {}", err);
        return Err(err);
    }

    println!(
        "[EXTRACT] Sucesso total! {} canais de áudio identificados e prontos para mixagem.",
        audio_files.len()
    );
    for (i, a) in audio_files.iter().enumerate() {
        println!("  -> Canal {}: {}", i + 1, a);
    }
    println!("[EXTRACT] ========================================================");

    Ok(audio_files)
}

/// Extração síncrona a partir de bytes em memória
pub fn extract_multitrack_zip_bytes_sync(
    zip_bytes: Vec<u8>,
    zip_name: Option<String>,
) -> Result<Vec<String>, String> {
    if zip_bytes.is_empty() {
        return Err("O pacote de dados ZIP está vazio (0 bytes).".to_string());
    }

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
    let _ = extract_archive(cursor, &target_dir);
    let audio_files = find_audio_files_recursively(&target_dir);
    if audio_files.is_empty() {
        return Err("Nenhum arquivo de áudio válido pôde ser extraído do pacote ZIP em memória.".to_string());
    }
    Ok(audio_files)
}

/// Leitura síncrona de arquivo de áudio do disco
pub fn read_audio_file_sync(file_path: &str) -> Result<Vec<u8>, String> {
    let p = Path::new(file_path);
    if !p.exists() {
        let err_msg = format!("Arquivo de áudio não encontrado: {}", file_path);
        eprintln!("[read_audio_file] {}", err_msg);
        return Err(err_msg);
    }

    match fs::read(file_path) {
        Ok(bytes) => {
            if bytes.is_empty() {
                let err_msg = format!("Arquivo de áudio está vazio (0 bytes): {}", file_path);
                eprintln!("[read_audio_file] {}", err_msg);
                return Err(err_msg);
            }
            Ok(bytes)
        }
        Err(e) => {
            let err_msg = format!("Falha de I/O ao ler {}: {}", file_path, e);
            eprintln!("[read_audio_file] {}", err_msg);
            Err(err_msg)
        }
    }
}

// -----------------------------------------------------------------------------
// TAURI COMMANDS (Assíncronos via tokio::task::spawn_blocking)
// -----------------------------------------------------------------------------

/// Extrai um arquivo .zip a partir de seu caminho no disco local
#[tauri::command]
pub async fn extract_multitrack_zip(zip_path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || extract_multitrack_zip_sync(&zip_path))
        .await
        .map_err(|e| format!("Erro na thread de descompactação: {}", e))?
}

/// Extrai um arquivo .zip recebido diretamente em bytes
#[tauri::command]
pub async fn extract_multitrack_zip_bytes(
    zip_bytes: Vec<u8>,
    zip_name: Option<String>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || extract_multitrack_zip_bytes_sync(zip_bytes, zip_name))
        .await
        .map_err(|e| format!("Erro na thread de descompactação: {}", e))?
}

/// Lê os bytes de um arquivo de áudio extraído no disco com IPC binário direto (Zero-Copy ArrayBuffer)
#[tauri::command]
pub async fn read_audio_file(file_path: String) -> Result<tauri::ipc::Response, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = read_audio_file_sync(&file_path)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| format!("Erro na leitura do arquivo de áudio: {}", e))?
}

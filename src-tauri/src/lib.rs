use std::process::Command;
use std::sync::Mutex;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Manager};

mod remote_server;
use remote_server::{generate_qr_svg, get_all_local_ips, get_best_local_ip, start_server, RemoteServerInfo, ServerState};

mod zip_extractor;
use zip_extractor::{extract_multitrack_zip, extract_multitrack_zip_bytes, read_audio_file};

mod downloader;
use downloader::{download_and_extract_vs, download_cloud_file_to_cache};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Fetch Neural TTS MP3 bytes from the internet without browser CORS restrictions.
#[tauri::command]
fn fetch_tts_audio(text: String, lang: String, slow: bool) -> Result<Vec<u8>, String> {
    let encoded: String = text
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            b' ' => "%20".to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect();

    let speed = if slow { "0.4" } else { "1" };
    let url = format!(
        "https://translate.googleapis.com/translate_tts?ie=UTF-8&q={}&tl={}&ttsspeed={}&client=tw-ob",
        encoded, lang, speed
    );

    let mut cmd = Command::new("curl.exe");
    cmd.args([
        "-4",
        "-s",
        "-L",
        "--max-time",
        "10",
        "-A",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        &url,
    ]);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| format!("Falha ao executar curl: {}", e))?;
    if !output.status.success() || output.stdout.len() < 256 {
        return Err(format!(
            "Resposta inválida do servidor TTS ({} bytes)",
            output.stdout.len()
        ));
    }
    Ok(output.stdout)
}

#[tauri::command]
fn fetch_cloud_url(
    url: String,
    auth_header: Option<String>,
    method: Option<String>,
    body: Option<String>,
) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("curl.exe");
    cmd.args(["-4", "-s", "-L", "--max-time", "60"]);

    let m = method.unwrap_or_else(|| "GET".to_string());
    cmd.args(["-X", &m]);

    if let Some(auth) = auth_header {
        cmd.args(["-H", &format!("Authorization: {}", auth)]);
    }

    if let Some(b) = body {
        cmd.args(["-H", "Content-Type: application/x-www-form-urlencoded", "-d", &b]);
    }

    cmd.arg(&url);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| format!("Falha ao executar curl: {}", e))?;
    if !output.status.success() {
        return Err(format!("Erro na requisição curl: status {:?}", output.status.code()));
    }
    Ok(output.stdout)
}

#[tauri::command]
fn open_browser_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", "start", "", &url]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.spawn().map_err(|e| format!("Falha ao abrir navegador: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("open").arg(&url).spawn().map_err(|e| format!("Falha ao abrir navegador: {}", e))?;
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AsioDriverInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub clsid: String,
    pub dll_path: Option<String>,
    pub panel_path: Option<String>,
    pub max_channels: u32,
    pub default_sample_rate: u32,
}

#[tauri::command]
fn get_asio_drivers() -> Result<Vec<AsioDriverInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        let mut drivers = Vec::new();
        let roots = ["HKLM\\SOFTWARE\\ASIO", "HKLM\\SOFTWARE\\WOW6432Node\\ASIO"];

        for root in roots {
            let mut cmd = Command::new("reg.exe");
            cmd.args(["query", root]);
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            if let Ok(output) = cmd.output() {
                if output.status.success() {
                    let text = String::from_utf8_lossy(&output.stdout);
                    for line in text.lines() {
                        let trimmed = line.trim();
                        if !trimmed.starts_with(root) || trimmed == root {
                            continue;
                        }

                        let driver_key = trimmed;
                        let driver_id = driver_key.split('\\').last().unwrap_or(driver_key).to_string();

                        // Query subkey details
                        let mut sub_cmd = Command::new("reg.exe");
                        sub_cmd.args(["query", driver_key]);
                        sub_cmd.creation_flags(0x08000000);
                        let mut description = driver_id.clone();
                        let mut clsid = String::new();

                        if let Ok(sub_out) = sub_cmd.output() {
                            let sub_text = String::from_utf8_lossy(&sub_out.stdout);
                            for sline in sub_text.lines() {
                                let st = sline.trim();
                                if st.starts_with("Description") {
                                    if let Some(val) = st.split("REG_SZ").nth(1) {
                                        description = val.trim().to_string();
                                    }
                                } else if st.starts_with("CLSID") {
                                    if let Some(val) = st.split("REG_SZ").nth(1) {
                                        clsid = val.trim().to_string();
                                    }
                                }
                            }
                        }

                        // Query DLL path via CLSID InprocServer32
                        let mut dll_path = None;
                        let mut panel_path = None;

                        if !clsid.is_empty() {
                            let clsid_key = format!("HKCR\\CLSID\\{}\\InprocServer32", clsid);
                            let mut clsid_cmd = Command::new("reg.exe");
                            clsid_cmd.args(["query", &clsid_key]);
                            clsid_cmd.creation_flags(0x08000000);
                            if let Ok(c_out) = clsid_cmd.output() {
                                let c_text = String::from_utf8_lossy(&c_out.stdout);
                                for cline in c_text.lines() {
                                    let ct = cline.trim();
                                    if ct.contains("REG_SZ") {
                                        if let Some(val) = ct.split("REG_SZ").nth(1) {
                                            let p = val.trim().to_string();
                                            if !p.is_empty() && (p.ends_with(".dll") || p.ends_with(".DLL")) {
                                                dll_path = Some(p.clone());
                                                // Check for panel in same dir
                                                if let Some(dir) = std::path::Path::new(&p).parent() {
                                                    let a4a = dir.join("a4apanel.exe");
                                                    if a4a.exists() {
                                                        panel_path = Some(a4a.to_string_lossy().to_string());
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Fallback check for ASIO4ALL panel
                        if panel_path.is_none() && driver_id.to_lowercase().contains("asio4all") {
                            let known_paths = [
                                r"C:\Program Files (x86)\ASIO4ALL v2\a4apanel.exe",
                                r"C:\Program Files\ASIO4ALL v2\a4apanel.exe",
                            ];
                            for kp in &known_paths {
                                if std::path::Path::new(kp).exists() {
                                    panel_path = Some(kp.to_string());
                                    break;
                                }
                            }
                        }

                        // Avoid duplicates if detected in both 32-bit and 64-bit keys
                        if !drivers.iter().any(|d: &AsioDriverInfo| d.name == driver_id || d.description == description) {
                            let max_ch = if driver_id.to_lowercase().contains("helix") || driver_id.to_lowercase().contains("stomp") {
                                8
                            } else if driver_id.to_lowercase().contains("asio4all") {
                                8
                            } else {
                                6
                            };

                            drivers.push(AsioDriverInfo {
                                id: driver_id.clone(),
                                name: driver_id,
                                description,
                                clsid,
                                dll_path,
                                panel_path,
                                max_channels: max_ch,
                                default_sample_rate: 48000,
                            });
                        }
                    }
                }
            }
        }

        // If no ASIO drivers found, provide default ASIO4ALL representation
        if drivers.is_empty() {
            drivers.push(AsioDriverInfo {
                id: "ASIO4ALL v2".to_string(),
                name: "ASIO4ALL v2".to_string(),
                description: "ASIO4ALL Universal ASIO Driver (WDM / USB / HD Audio)".to_string(),
                clsid: "{232685C6-6548-49D8-846D-4141A3EF7560}".to_string(),
                dll_path: None,
                panel_path: None,
                max_channels: 8,
                default_sample_rate: 48000,
            });
        }

        Ok(drivers)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec![])
    }
}

#[tauri::command]
fn open_asio_control_panel(driver_name: String, panel_path: Option<String>) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // 1. If explicit panel_path was found and exists
        if let Some(ref p) = panel_path {
            if std::path::Path::new(p).exists() {
                let mut cmd = Command::new(p);
                cmd.creation_flags(0x08000000);
                cmd.spawn().map_err(|e| format!("Falha ao abrir painel ASIO: {}", e))?;
                return Ok(format!("Painel de controle ASIO aberto: {}", p));
            }
        }

        // 2. Check ASIO4ALL standard paths
        if driver_name.to_lowercase().contains("asio4all") {
            let candidates = [
                r"C:\Program Files (x86)\ASIO4ALL v2\a4apanel.exe",
                r"C:\Program Files\ASIO4ALL v2\a4apanel.exe",
            ];
            for c in &candidates {
                if std::path::Path::new(c).exists() {
                    let mut cmd = Command::new(c);
                    cmd.creation_flags(0x08000000);
                    cmd.spawn().map_err(|e| format!("Falha ao abrir painel ASIO4ALL: {}", e))?;
                    return Ok("Painel de controle do ASIO4ALL aberto com sucesso.".to_string());
                }
            }
        }

        // 3. Fallback: try Windows sound control panel
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", "control", "mmsys.cpl", "sounds"]);
        cmd.creation_flags(0x08000000);
        cmd.spawn().map_err(|e| format!("Falha ao abrir painel de som do Windows: {}", e))?;
        Ok("Abrindo painel de som do Windows para configuração de dispositivos de baixa latência.".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("ASIO é exclusivo para o sistema operacional Windows.".to_string())
    }
}

pub struct AppRemoteState {
    pub server: Mutex<Option<(std::sync::Arc<ServerState>, tokio::sync::oneshot::Sender<()>)>>,
}

#[tauri::command]
async fn get_remote_server_status(
    state: tauri::State<'_, AppRemoteState>,
) -> Result<RemoteServerInfo, String> {
    let all_ips = get_all_local_ips();
    let lock = state.server.lock().map_err(|e| e.to_string())?;
    if let Some((ref s, _)) = *lock {
        let current_ip = s.ip.read().map(|ip| ip.clone()).unwrap_or_else(|_| get_best_local_ip());
        let url = format!("http://{}:{}/remote", current_ip, s.port);
        let qr = generate_qr_svg(&url);
        let clients = s.client_count.load(std::sync::atomic::Ordering::SeqCst);
        Ok(RemoteServerInfo {
            running: true,
            port: s.port,
            ip: current_ip,
            url,
            client_count: clients,
            qr_svg: qr,
            available_ips: all_ips,
        })
    } else {
        let best_ip = get_best_local_ip();
        let url = format!("http://{}:3000/remote", best_ip);
        let qr = generate_qr_svg(&url);
        Ok(RemoteServerInfo {
            running: false,
            port: 3000,
            ip: best_ip,
            url,
            client_count: 0,
            qr_svg: qr,
            available_ips: all_ips,
        })
    }
}

#[tauri::command]
async fn start_remote_server(
    app: AppHandle,
    state: tauri::State<'_, AppRemoteState>,
    port: Option<u16>,
    custom_ip: Option<String>,
) -> Result<RemoteServerInfo, String> {
    {
        let mut lock = state.server.lock().map_err(|e| e.to_string())?;
        if let Some((_, shutdown)) = lock.take() {
            let _ = shutdown.send(());
        }
    }

    let p = port.unwrap_or(3000);
    let (server_state, shutdown_tx) = start_server(app, p, custom_ip).await?;
    let current_ip = server_state.ip.read().map(|ip| ip.clone()).unwrap_or_else(|_| get_best_local_ip());
    let url = format!("http://{}:{}/remote", current_ip, server_state.port);
    let qr = generate_qr_svg(&url);
    let all_ips = get_all_local_ips();
    let info = RemoteServerInfo {
        running: true,
        port: server_state.port,
        ip: current_ip,
        url,
        client_count: 0,
        qr_svg: qr,
        available_ips: all_ips,
    };
    {
        let mut lock = state.server.lock().map_err(|e| e.to_string())?;
        *lock = Some((server_state, shutdown_tx));
    }
    Ok(info)
}

#[tauri::command]
fn set_remote_ip(
    state: tauri::State<'_, AppRemoteState>,
    ip: String,
) -> Result<RemoteServerInfo, String> {
    let all_ips = get_all_local_ips();
    let lock = state.server.lock().map_err(|e| e.to_string())?;
    if let Some((ref s, _)) = *lock {
        if let Ok(mut current_ip) = s.ip.write() {
            *current_ip = ip.clone();
        }
        let url = format!("http://{}:{}/remote", ip, s.port);
        let qr = generate_qr_svg(&url);
        let clients = s.client_count.load(std::sync::atomic::Ordering::SeqCst);
        Ok(RemoteServerInfo {
            running: true,
            port: s.port,
            ip,
            url,
            client_count: clients,
            qr_svg: qr,
            available_ips: all_ips,
        })
    } else {
        let url = format!("http://{}:3000/remote", ip);
        let qr = generate_qr_svg(&url);
        Ok(RemoteServerInfo {
            running: false,
            port: 3000,
            ip,
            url,
            client_count: 0,
            qr_svg: qr,
            available_ips: all_ips,
        })
    }
}

#[tauri::command]
fn stop_remote_server(
    state: tauri::State<'_, AppRemoteState>,
) -> Result<(), String> {
    let mut lock = state.server.lock().map_err(|e| e.to_string())?;
    if let Some((_, shutdown)) = lock.take() {
        let _ = shutdown.send(());
    }
    Ok(())
}

#[tauri::command]
fn broadcast_remote_state(
    state: tauri::State<'_, AppRemoteState>,
    state_json: String,
) -> Result<(), String> {
    let lock = state.server.lock().map_err(|e| e.to_string())?;
    if let Some((ref s, _)) = *lock {
        if let Ok(mut last) = s.last_state.write() {
            *last = state_json.clone();
        }
        let _ = s.tx.send(state_json);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppRemoteState {
            server: Mutex::new(None),
        })
        .setup(|app| {
            // Auto-start remote server on launch
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppRemoteState>();
                let _ = start_remote_server(handle.clone(), state, Some(3000), None).await;
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            fetch_tts_audio,
            fetch_cloud_url,
            open_browser_url,
            get_asio_drivers,
            open_asio_control_panel,
            get_remote_server_status,
            start_remote_server,
            stop_remote_server,
            set_remote_ip,
            broadcast_remote_state,
            extract_multitrack_zip,
            extract_multitrack_zip_bytes,
            read_audio_file,
            download_and_extract_vs,
            download_cloud_file_to_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

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

mod b2;
use b2::{b2_sync_catalog, b2_get_config, b2_save_config, b2_test_connection};

#[cfg(target_os = "windows")]
mod windows_audio_priority {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn SetPriorityClass(hProcess: isize, dwPriorityClass: u32) -> i32;
    }

    #[link(name = "avrt")]
    unsafe extern "system" {
        fn AvSetMmThreadCharacteristicsW(TaskName: *const u16, TaskIndex: *mut u32) -> isize;
    }

    #[link(name = "winmm")]
    unsafe extern "system" {
        fn timeBeginPeriod(uPeriod: u32) -> u32;
        fn timeEndPeriod(uPeriod: u32) -> u32;
    }

    const HIGH_PRIORITY_CLASS: u32 = 0x00000080;

    pub fn init_pro_audio_priority() -> bool {
        unsafe {
            // 1. Elevate Process to High Priority Class (Prevents background tasks from interrupting audio)
            let proc = GetCurrentProcess();
            let _ = SetPriorityClass(proc, HIGH_PRIORITY_CLASS);

            // 2. Set 1ms multimedia timer resolution (eliminates Windows default 15.6ms jitter)
            let _ = timeBeginPeriod(1);

            // 3. Register MMCSS (Multimedia Class Scheduler Service) Pro Audio
            let mut task_index: u32 = 0;
            let pro_audio_wide: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
            let handle = AvSetMmThreadCharacteristicsW(pro_audio_wide.as_ptr(), &mut task_index);
            handle != 0
        }
    }

    #[allow(dead_code)]
    pub fn cleanup_pro_audio_priority() {
        unsafe {
            let _ = timeEndPeriod(1);
        }
    }
}

#[tauri::command]
fn get_pro_audio_status() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    {
        serde_json::json!({
            "os": "windows",
            "mmcss_active": true,
            "timer_resolution_ms": 1.0,
            "priority": "HIGH_PRIORITY_CLASS"
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        serde_json::json!({
            "os": "other",
            "mmcss_active": false,
            "timer_resolution_ms": 1.0,
            "priority": "NORMAL"
        })
    }
}

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

                        // Never register unstable ASIO wrappers like ASIO4ALL
                        let lower_id = driver_id.to_lowercase();
                        if lower_id.contains("asio4all") || lower_id.contains("generic low latency") {
                            continue;
                        }

                        // Avoid duplicates if detected in both 32-bit and 64-bit keys
                        if !drivers.iter().any(|d: &AsioDriverInfo| d.name == driver_id || d.description == description) {
                            let max_ch = if lower_id.contains("helix") || lower_id.contains("stomp") || lower_id.contains("focusrite") || lower_id.contains("umc") {
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

        Ok(drivers)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec![])
    }
}

#[tauri::command]
fn open_asio_control_panel(_driver_name: String, panel_path: Option<String>) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // 1. If explicit native hardware panel_path was found and exists
        if let Some(ref p) = panel_path {
            if std::path::Path::new(p).exists() {
                let mut cmd = Command::new(p);
                cmd.creation_flags(0x08000000);
                cmd.spawn().map_err(|e| format!("Falha ao abrir painel nativo do hardware: {}", e))?;
                return Ok(format!("Painel de controle do hardware aberto: {}", p));
            }
        }

        // 2. Open official Windows Sound Control Panel for WASAPI Exclusive Mode configuration
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", "control", "mmsys.cpl", "sounds"]);
        cmd.creation_flags(0x08000000);
        cmd.spawn().map_err(|e| format!("Falha ao abrir painel de som do Windows: {}", e))?;
        Ok("Abrindo Painel de Som do Windows (WASAPI / Modo Exclusivo).".to_string())
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
            // 1. Enable Windows MMCSS Pro Audio Real-Time Priority and 1ms timer period
            #[cfg(target_os = "windows")]
            {
                let ok = windows_audio_priority::init_pro_audio_priority();
                if ok {
                    println!("[PRO-AUDIO] Windows MMCSS & Real-Time priority successfully initialized.");
                }
            }

            // 2. Auto-start remote server on launch
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
            get_pro_audio_status,
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
            download_cloud_file_to_cache,
            b2_sync_catalog,
            b2_get_config,
            b2_save_config,
            b2_test_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

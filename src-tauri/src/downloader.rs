use std::fs;
use std::path::Path;
use std::time::Instant;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DownloadProgressPayload {
    pub task_id: String,
    pub percent: u32,
    pub status_text: String,
    pub current_track_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedAudioTrack {
    pub file_name: String,
    pub file_path: String,
    pub file_size: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadVsResult {
    pub success: bool,
    pub song_title: String,
    pub zip_path: String,
    pub audio_files: Vec<ExtractedAudioTrack>,
}

const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// Command entrypoint: Dispatches the download into a dedicated Tokio background task
/// to strictly prevent any freezing of the Tauri main UI thread.
#[tauri::command]
pub async fn download_and_extract_vs(
    app: AppHandle,
    url: String,
    auth_header: Option<String>,
    song_title: String,
    task_id: String,
) -> Result<DownloadVsResult, String> {
    tokio::spawn(async move {
        download_and_extract_vs_inner(app, url, auth_header, song_title, task_id).await
    })
    .await
    .map_err(|e| format!("Falha na execução em background da tarefa de download: {}", e))?
}

/// Inner download & extraction worker running strictly on the Tokio worker threadpool.
async fn download_and_extract_vs_inner(
    app: AppHandle,
    url: String,
    auth_header: Option<String>,
    song_title: String,
    task_id: String,
) -> Result<DownloadVsResult, String> {
    let download_dir = app
        .path()
        .app_cache_dir()
        .map(|p| p.join("multitracks_cache"))
        .unwrap_or_else(|_| std::env::temp_dir().join("worship_playback_pro").join("multitracks_cache"));

    tokio::fs::create_dir_all(&download_dir)
        .await
        .map_err(|e| format!("Falha ao criar diretório de cache de download: {}", e))?;

    let safe_title = song_title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();

    let zip_filename = format!("{}.zip", safe_title);
    let zip_path = download_dir.join(&zip_filename);
    let zip_path_clone = zip_path.clone();

    // 🚀 CACHE LOCAL CHECK: Se o arquivo ZIP já estiver baixado no PC, reutiliza 100% (0 tráfego B2!)
    let mut use_local_cache = false;
    if zip_path.exists() {
        if let Ok(meta) = std::fs::metadata(&zip_path) {
            if meta.len() > 1024 {
                println!(
                    "[CACHE] ✨ Pacote ZIP encontrado no cache local do PC para \"{}\" ({:.2} MB). Economia total de tráfego B2!",
                    song_title,
                    meta.len() as f64 / 1_048_576.0
                );
                use_local_cache = true;
            }
        }
    }

    let mut download_succeeded = false;

    if use_local_cache {
        // Skip download entirely - we already have the ZIP cached locally!
        let _ = app.emit(
            "download-progress",
            DownloadProgressPayload {
                task_id: task_id.clone(),
                percent: 70,
                status_text: format!("⚡ Usando cache local do PC para \"{}\" (0 KB de tráfego B2)...", song_title),
                current_track_name: None,
            },
        );
        download_succeeded = true;
        println!("[CACHE] Pulando download - usando arquivo ZIP já salvo no cache local.");
    } else {
        // --- DOWNLOAD FROM B2 ---
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(900))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|e| format!("Falha ao inicializar cliente HTTP: {}", e))?;

        let max_retries: u32 = 4;
        let mut downloaded: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut last_emit = Instant::now();

        println!("[DOWNLOAD] Iniciando fluxo de download para \"{}\"", song_title);

        for attempt in 1..=max_retries {
            println!(
                "[DOWNLOAD] Tentativa {}/{} para \"{}\" (baixados até agora: {} bytes)...",
                attempt, max_retries, song_title, downloaded
            );

            let mut req = client.get(&url);
            if let Some(auth) = &auth_header {
                req = req.header("Authorization", auth);
            }
            req = req.header("User-Agent", BROWSER_USER_AGENT);
            req = req.header("Accept", "*/*");

            // Try resuming if partial download already exists
            if downloaded > 0 {
                println!("[DOWNLOAD] Solicitando retomada HTTP Range: bytes={}-", downloaded);
                req = req.header("Range", format!("bytes={}-", downloaded));
            }

            let _ = app.emit(
                "download-progress",
                DownloadProgressPayload {
                    task_id: task_id.clone(),
                    percent: if total_bytes > 0 {
                        (5.0 + ((downloaded as f64 / total_bytes as f64) * 65.0).min(65.0)) as u32
                    } else {
                        5
                    },
                    status_text: if attempt == 1 {
                        format!("Conectando ao servidor para \"{}\"...", song_title)
                    } else {
                        format!("Reconectando à nuvem (tentativa {}/{})...", attempt, max_retries)
                    },
                    current_track_name: None,
                },
            );

            let send_res = tokio::time::timeout(std::time::Duration::from_secs(20), req.send()).await;
            let resp = match send_res {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => {
                    eprintln!("[DOWNLOAD] Erro de rede na conexão (tentativa {}/{}): {}", attempt, max_retries, e);
                    if attempt == max_retries {
                        return Err(format!("Falha na conexão de download após {} tentativas: {}", max_retries, e));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(1500 * attempt as u64)).await;
                    continue;
                }
                Err(_) => {
                    eprintln!("[DOWNLOAD] Timeout de 20s ao conectar ao servidor (tentativa {}/{})", attempt, max_retries);
                    if attempt == max_retries {
                        return Err(format!("Tempo limite de conexão esgotado após {} tentativas", max_retries));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(1500 * attempt as u64)).await;
                    continue;
                }
            };

            let status = resp.status();
            println!("[DOWNLOAD] Resposta recebida: HTTP {}", status);

            if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
                let err_text = resp.text().await.unwrap_or_default();
                eprintln!("[DOWNLOAD] Erro retornado pelo servidor: HTTP {}: {}", status, err_text);
                return Err(format!("Download falhou com status HTTP {}: {}", status, err_text));
            }

            // Validate content-type: prevent Google Drive HTML error pages from pretending to be zip files
            if let Some(ct) = resp.headers().get("content-type") {
                let ct_str = ct.to_str().unwrap_or_default().to_lowercase();
                if ct_str.contains("text/html") {
                    let body_sample = resp.text().await.unwrap_or_default();
                    eprintln!(
                        "[DOWNLOAD] Servidor retornou HTML em vez do arquivo: {}",
                        &body_sample[..body_sample.len().min(400)]
                    );
                    return Err("O servidor retornou uma página HTML em vez do arquivo de áudio (token de autenticação expirado ou cota do Google Drive atingida).".to_string());
                }
            }

            // Validate content-length & partial range
            if status == reqwest::StatusCode::PARTIAL_CONTENT {
                if let Some(cr) = resp.headers().get("content-range") {
                    if let Ok(cr_str) = cr.to_str() {
                        if let Some(total_str) = cr_str.split('/').last() {
                            if let Ok(tot) = total_str.trim().parse::<u64>() {
                                total_bytes = tot;
                            }
                        }
                    }
                }
            } else {
                // Full content received; reset counter and file
                downloaded = 0;
                total_bytes = resp.content_length().unwrap_or(0);
            }

            println!(
                "[DOWNLOAD] Tamanho total apurado: {} bytes ({:.2} MB)",
                total_bytes,
                total_bytes as f64 / 1_048_576.0
            );

            let raw_file = match tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(downloaded == 0)
                .append(downloaded > 0)
                .open(&zip_path)
                .await
            {
                Ok(f) => f,
                Err(e) => return Err(format!("Falha ao abrir arquivo temporário no disco: {}", e)),
            };
            let mut file = tokio::io::BufWriter::with_capacity(512 * 1024, raw_file);

            let mut stream = resp.bytes_stream();
            let mut chunk_error = false;

            loop {
                // Per-chunk timeout of 60 seconds (was 15s) to allow large files on slow connections
                let chunk_res = tokio::time::timeout(std::time::Duration::from_secs(60), stream.next()).await;

                match chunk_res {
                    Ok(Some(Ok(chunk))) => {
                        if let Err(e) = file.write_all(&chunk).await {
                            return Err(format!("Falha ao gravar bloco no disco: {}", e));
                        }
                        downloaded += chunk.len() as u64;

                        if last_emit.elapsed().as_millis() >= 120 {
                            let percent = if total_bytes > 0 {
                                (5.0 + ((downloaded as f64 / total_bytes as f64) * 65.0).min(65.0)) as u32
                            } else {
                                (5.0 + ((downloaded as f64 / (40.0 * 1024.0 * 1024.0)) * 65.0).min(63.0)) as u32
                            };

                            let mb_down = downloaded as f64 / 1_048_576.0;
                            let status_text = if total_bytes > 0 {
                                let mb_total = total_bytes as f64 / 1_048_576.0;
                                format!("Baixando pacote ({:.1} MB / {:.1} MB)...", mb_down, mb_total)
                            } else {
                                format!("Baixando pacote ({:.1} MB)...", mb_down)
                            };

                            let _ = app.emit(
                                "download-progress",
                                DownloadProgressPayload {
                                    task_id: task_id.clone(),
                                    percent,
                                    status_text,
                                    current_track_name: None,
                                },
                            );
                            last_emit = Instant::now();
                        }
                    }
                    Ok(Some(Err(e))) => {
                        eprintln!("[DOWNLOAD] Erro no stream de dados (tentativa {}): {}", attempt, e);
                        chunk_error = true;
                        break;
                    }
                    Ok(None) => {
                        // Stream finished cleanly
                        break;
                    }
                    Err(_) => {
                        eprintln!(
                            "[DOWNLOAD] Stream parou de responder por mais de 60s (tentativa {}/{}). Reconectando...",
                            attempt, max_retries
                        );
                        chunk_error = true;
                        break;
                    }
                }
            }

            let _ = file.flush().await;

            if !chunk_error {
                if total_bytes > 0 && downloaded < total_bytes {
                    println!(
                        "[DOWNLOAD] Conexão encerrou prematuramente ({} de {} bytes). Retentando...",
                        downloaded, total_bytes
                    );
                    continue;
                }

                // 1. Fechamento EXPLÍCITO e Flush do handle antes de iniciar a descompactação (Evita File Lock no Windows)
                let mut inner_file = file.into_inner();
                let _ = inner_file.flush().await;
                let _ = inner_file.sync_all().await;
                drop(inner_file);

                println!("[DOWNLOAD] Download concluído com êxito! Total: {} bytes", downloaded);
                download_succeeded = true;

                // Breve yield para o kernel do Windows desalocar os descritores de arquivo
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                break;
            }

            // Se houve erro no chunk (timeout ou erro de stream), resetar downloaded para reiniciar do zero
            // em vez de tentar resume com Range (que pode falhar se o servidor não suportar bem)
            eprintln!(
                "[DOWNLOAD] Erro no stream detectado. Reiniciando download do início (tentativa {}/{})...",
                attempt, max_retries
            );
            downloaded = 0;
            total_bytes = 0;

            if attempt == max_retries {
                return Err(format!("Stream de download interrompida após {} tentativas", max_retries));
            }

            tokio::time::sleep(std::time::Duration::from_millis(1000 * attempt as u64)).await;
        }
    }

    if !download_succeeded {
        return Err("Arquivo de download vazio ou não finalizado com sucesso.".to_string());
    }

    // Now extract the zip file asynchronously
    let _ = app.emit(
        "download-progress",
        DownloadProgressPayload {
            task_id: task_id.clone(),
            percent: 75,
            status_text: "Descompactando canais de áudio diretamente no disco...".to_string(),
            current_track_name: None,
        },
    );

    let zip_path_str = zip_path.to_string_lossy().to_string();

    println!("[EXTRACT] Iniciando descompactação nativa em thread isolada para \"{}\"...", song_title);

    // Run synchronous extraction on worker threadpool so Tauri main loop is NEVER blocked
    let extracted_paths = tokio::task::spawn_blocking(move || {
        crate::zip_extractor::extract_multitrack_zip_sync(&zip_path_str)
    })
    .await
    .map_err(|e| format!("Erro ao agendar descompactação: {}", e))??;

    let mut audio_files = Vec::new();
    let total_tracks = extracted_paths.len();
    println!("[TRACKS] Iniciando identificação de {} tracks extraídas...", total_tracks);

    // Track identification with per-item exception handling: if one track fails, log & continue
    for (idx, p) in extracted_paths.into_iter().enumerate() {
        let path = Path::new(&p);
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("track_{}.wav", idx + 1));

        println!("[TRACKS] Verificando track {}/{}: {}", idx + 1, total_tracks, file_name);

        match fs::metadata(&p) {
            Ok(meta) => {
                let file_size = meta.len();
                if file_size == 0 {
                    eprintln!("[TRACKS] Arquivo {} ({}/{}) tem 0 bytes. Ignorando...", file_name, idx + 1, total_tracks);
                    continue;
                }
                println!(
                    "[TRACKS] Track {}/{} identificada: {} ({:.2} MB)",
                    idx + 1,
                    total_tracks,
                    file_name,
                    file_size as f64 / 1_048_576.0
                );
                audio_files.push(ExtractedAudioTrack {
                    file_name,
                    file_path: p,
                    file_size,
                });
            }
            Err(e) => {
                eprintln!(
                    "[TRACKS] Erro ao ler metadados da track {}/{} ({}): {}. Ignorando e continuando...",
                    idx + 1,
                    total_tracks,
                    file_name,
                    e
                );
                continue;
            }
        }
    }

    if audio_files.is_empty() {
        return Err("Nenhum arquivo de áudio válido pôde ser identificado após descompactação.".to_string());
    }

    let _ = app.emit(
        "download-progress",
        DownloadProgressPayload {
            task_id: task_id.clone(),
            percent: 85,
            status_text: format!("{} canais identificados e validados com sucesso!", audio_files.len()),
            current_track_name: None,
        },
    );

    Ok(DownloadVsResult {
        success: true,
        song_title,
        zip_path: zip_path_clone.to_string_lossy().to_string(),
        audio_files,
    })
}

/// Downloads a single cloud audio stem directly to local disk cache,
/// with automatic retry, timeout protection, and browser User-Agent,
/// running strictly on an isolated Tokio background task.
#[tauri::command]
pub async fn download_cloud_file_to_cache(
    url: String,
    auth_header: Option<String>,
    file_name: String,
) -> Result<String, String> {
    tokio::spawn(async move {
        download_cloud_file_to_cache_inner(url, auth_header, file_name).await
    })
    .await
    .map_err(|e| format!("Falha na execução em background do download de stem: {}", e))?
}

async fn download_cloud_file_to_cache_inner(
    url: String,
    auth_header: Option<String>,
    file_name: String,
) -> Result<String, String> {
    let cache_dir = std::env::temp_dir()
        .join("worship_playback_pro")
        .join("stems_cache");

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("Falha ao criar diretório de cache: {}", e))?;

    let file_path = cache_dir.join(&file_name);
    if file_path.exists() {
        if let Ok(meta) = fs::metadata(&file_path) {
            if meta.len() > 0 {
                return Ok(file_path.to_string_lossy().to_string());
            }
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Falha ao inicializar cliente HTTP: {}", e))?;

    let max_retries = 3;
    for attempt in 1..=max_retries {
        let mut req = client.get(&url);
        if let Some(auth) = &auth_header {
            req = req.header("Authorization", auth);
        }
        req = req.header("User-Agent", BROWSER_USER_AGENT);

        let send_res = tokio::time::timeout(std::time::Duration::from_secs(20), req.send()).await;
        let resp = match send_res {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                eprintln!("[CACHE_DOWNLOAD] Erro ao baixar {} (tentativa {}/{}): {}", file_name, attempt, max_retries, e);
                if attempt == max_retries {
                    return Err(format!("Falha no download de {} após {} tentativas: {}", file_name, max_retries, e));
                }
                tokio::time::sleep(std::time::Duration::from_millis(1000 * attempt as u64)).await;
                continue;
            }
            Err(_) => {
                eprintln!("[CACHE_DOWNLOAD] Timeout de 20s para {} (tentativa {}/{})", file_name, attempt, max_retries);
                if attempt == max_retries {
                    return Err(format!("Timeout no download de {} após {} tentativas", file_name, max_retries));
                }
                tokio::time::sleep(std::time::Duration::from_millis(1000 * attempt as u64)).await;
                continue;
            }
        };

        if !resp.status().is_success() {
            return Err(format!("Falha no download HTTP {}", resp.status()));
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Falha ao ler dados de {}: {}", file_name, e))?;

        if bytes.is_empty() {
            return Err(format!("Dados recebidos vazios para {}", file_name));
        }

        tokio::fs::write(&file_path, bytes)
            .await
            .map_err(|e| format!("Falha ao salvar no cache: {}", e))?;

        return Ok(file_path.to_string_lossy().to_string());
    }

    Err(format!("Falha ao obter {} da nuvem", file_name))
}
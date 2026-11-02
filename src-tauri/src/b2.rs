use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const DEFAULT_BUCKET_NAME: &str = "worship-playback-vs";
pub const DEFAULT_BUCKET_ID: &str = "437f98cd55f48a50af1e0e16";
pub const DEFAULT_KEY_ID: &str = "0053f8d54a0fee60000000003";
pub const DEFAULT_APPLICATION_KEY: &str = "K005Oq/5orR64KcpTr3HsUBsMIvgsUI";
pub const DEFAULT_B2_BASE_URL: &str = "https://f005.backblazeb2.com/file/worship-playback-vs/";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct B2Config {
    pub bucket_name: String,
    pub bucket_id: String,
    pub key_id: String,
    pub application_key: String,
    pub download_url: String,
}

impl Default for B2Config {
    fn default() -> Self {
        Self {
            bucket_name: DEFAULT_BUCKET_NAME.to_string(),
            bucket_id: DEFAULT_BUCKET_ID.to_string(),
            key_id: DEFAULT_KEY_ID.to_string(),
            application_key: DEFAULT_APPLICATION_KEY.to_string(),
            download_url: DEFAULT_B2_BASE_URL.to_string(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct B2Allowed {
    pub bucket_id: Option<String>,
    pub bucket_name: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub name_prefix: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct B2StorageApi {
    pub api_url: Option<String>,
    pub download_url: Option<String>,
    pub bucket_id: Option<String>,
    pub bucket_name: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub name_prefix: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct B2ApiInfo {
    pub storage_api: Option<B2StorageApi>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct B2AuthorizeAccountResponse {
    pub account_id: Option<String>,
    pub authorization_token: Option<String>,
    pub api_url: Option<String>,
    pub download_url: Option<String>,
    pub allowed: Option<B2Allowed>,
    pub api_info: Option<B2ApiInfo>,
}

impl B2AuthorizeAccountResponse {
    pub fn effective_api_url(&self) -> String {
        if let Some(ref url) = self.api_url {
            if !url.trim().is_empty() {
                return url.trim().trim_end_matches('/').to_string();
            }
        }
        if let Some(ref info) = self.api_info {
            if let Some(ref storage) = info.storage_api {
                if let Some(ref url) = storage.api_url {
                    if !url.trim().is_empty() {
                        return url.trim().trim_end_matches('/').to_string();
                    }
                }
            }
        }
        "https://api.backblazeb2.com".to_string()
    }

    pub fn effective_download_url(&self) -> String {
        if let Some(ref url) = self.download_url {
            if !url.trim().is_empty() {
                return url.trim().trim_end_matches('/').to_string();
            }
        }
        if let Some(ref info) = self.api_info {
            if let Some(ref storage) = info.storage_api {
                if let Some(ref url) = storage.download_url {
                    if !url.trim().is_empty() {
                        return url.trim().trim_end_matches('/').to_string();
                    }
                }
            }
        }
        "https://f005.backblazeb2.com".to_string()
    }

    pub fn effective_bucket_id(&self) -> Option<String> {
        if let Some(ref allowed) = self.allowed {
            if let Some(ref id) = allowed.bucket_id {
                if !id.trim().is_empty() {
                    return Some(id.trim().to_string());
                }
            }
        }
        if let Some(ref info) = self.api_info {
            if let Some(ref storage) = info.storage_api {
                if let Some(ref id) = storage.bucket_id {
                    if !id.trim().is_empty() {
                        return Some(id.trim().to_string());
                    }
                }
            }
        }
        None
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct B2FileItem {
    pub file_id: Option<String>,
    pub file_name: String,
    pub content_length: u64,
    pub upload_timestamp: Option<u64>,
    pub action: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct B2ListFileNamesResponse {
    pub files: Vec<B2FileItem>,
    pub next_file_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct B2SyncResult {
    pub success: bool,
    pub bucket_name: String,
    pub bucket_id: String,
    pub total_files_in_bucket: usize,
    pub package_files: Vec<B2FileItem>,
    pub download_base_url: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct B2TestConnectionResult {
    pub success: bool,
    pub status: u16,
    pub message: String,
    pub bucket_id: String,
    pub bucket_name: String,
    pub download_base_url: String,
    pub files_count: usize,
}

/// Valida se uma string é um Bucket ID válido da B2 (24 caracteres hexadecimais).
/// Descarta strings inválidas como "WorshipAppUploader" (que são nomes de chave/bucket, não IDs).
pub fn is_valid_bucket_id(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("WorshipAppUploader") {
        return false;
    }
    t.len() == 24 && t.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn get_b2_config_path(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().app_data_dir() {
        return dir.join("b2_config.json");
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("worship-playback-pro").join("b2_config.json");
    }
    PathBuf::from("b2_config.json")
}

pub fn load_b2_config(app: &AppHandle) -> B2Config {
    let path = get_b2_config_path(app);
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(mut parsed) = serde_json::from_str::<B2Config>(&content) {
                // Sanitização contra "WorshipAppUploader" ou Bucket ID inválido
                if !is_valid_bucket_id(&parsed.bucket_id) {
                    parsed.bucket_id = DEFAULT_BUCKET_ID.to_string();
                }
                return parsed;
            }
        }
    }
    // Grava o arquivo default caso não exista
    let def = B2Config::default();
    let _ = save_b2_config(app, &def);
    def
}

pub fn save_b2_config(app: &AppHandle, config: &B2Config) -> Result<(), String> {
    let path = get_b2_config_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut sanitized = config.clone();
    if !is_valid_bucket_id(&sanitized.bucket_id) {
        sanitized.bucket_id = DEFAULT_BUCKET_ID.to_string();
    }
    let json = serde_json::to_string_pretty(&sanitized)
        .map_err(|e| format!("Erro ao serializar b2_config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Erro ao salvar b2_config.json: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn b2_get_config(app: AppHandle) -> B2Config {
    load_b2_config(&app)
}

#[tauri::command]
pub fn b2_save_config(app: AppHandle, config: B2Config) -> Result<(), String> {
    save_b2_config(&app, &config)
}

/// Testa a conexão com a API do Backblaze B2 diretamente via Rust (sem fetch/CORS do WebView).
#[tauri::command]
pub async fn b2_test_connection(
    app: AppHandle,
    key_id: Option<String>,
    application_key: Option<String>,
    bucket_id: Option<String>,
    bucket_name: Option<String>,
) -> Result<B2TestConnectionResult, String> {
    println!("[B2-TEST] Testando autorização e conexão com Backblaze B2 (Rust nativo)...");

    let mut config = load_b2_config(&app);
    if let Some(k) = key_id {
        if !k.trim().is_empty() {
            config.key_id = k.trim().to_string();
        }
    }
    if let Some(k) = application_key {
        if !k.trim().is_empty() {
            config.application_key = k.trim().to_string();
        }
    }
    if let Some(b) = bucket_id {
        if is_valid_bucket_id(&b) {
            config.bucket_id = b.trim().to_string();
        }
    }
    if let Some(bn) = bucket_name {
        if !bn.trim().is_empty() {
            config.bucket_name = bn.trim().to_string();
        }
    }

    let client = reqwest::Client::builder()
        .user_agent("WorshipPlaybackPro/1.0.0 (Windows NT)")
        .build()
        .map_err(|e| format!("Falha ao inicializar HTTP client: {}", e))?;

    let auth_res = client
        .get("https://api.backblazeb2.com/b2api/v2/b2_authorize_account")
        .basic_auth(&config.key_id, Some(&config.application_key))
        .send()
        .await
        .map_err(|e| format!("Falha de conexão ao autorizar Backblaze B2: {}", e))?;

    if !auth_res.status().is_success() {
        let status = auth_res.status().as_u16();
        let err_text = auth_res.text().await.unwrap_or_default();
        return Ok(B2TestConnectionResult {
            success: false,
            status,
            message: format!("Erro na autorização B2 (HTTP {}): {}", status, err_text),
            bucket_id: config.bucket_id.clone(),
            bucket_name: config.bucket_name.clone(),
            download_base_url: config.download_url.clone(),
            files_count: 0,
        });
    }

    let auth_data: B2AuthorizeAccountResponse = auth_res
        .json()
        .await
        .map_err(|e| format!("Falha ao decodificar resposta da B2: {}", e))?;

    let token = auth_data
        .authorization_token
        .clone()
        .ok_or_else(|| "Token de autorização não recebido da B2".to_string())?;

    let api_url = auth_data.effective_api_url();
    let download_url = auth_data.effective_download_url();

    let resolved_bucket_id = auth_data
        .effective_bucket_id()
        .filter(|id| is_valid_bucket_id(id))
        .or_else(|| {
            if is_valid_bucket_id(&config.bucket_id) {
                Some(config.bucket_id.clone())
            } else {
                None
            }
        })
        .unwrap_or_else(|| DEFAULT_BUCKET_ID.to_string());

    config.bucket_id = resolved_bucket_id.clone();
    let _ = save_b2_config(&app, &config);

    // Consulta teste para validar listagem e contar pacotes
    let list_url = format!("{}/b2api/v2/b2_list_file_names", api_url.trim_end_matches('/'));
    let list_res = client
        .post(&list_url)
        .header("Authorization", &token)
        .json(&serde_json::json!({
            "bucketId": resolved_bucket_id,
            "maxFileCount": 100
        }))
        .send()
        .await
        .map_err(|e| format!("Falha ao consultar b2_list_file_names: {}", e))?;

    if !list_res.status().is_success() {
        let status = list_res.status().as_u16();
        let err_text = list_res.text().await.unwrap_or_default();
        return Ok(B2TestConnectionResult {
            success: false,
            status,
            message: format!("Autorizado, mas acesso ao bucket falhou (HTTP {}): {}", status, err_text),
            bucket_id: resolved_bucket_id,
            bucket_name: config.bucket_name.clone(),
            download_base_url: format!("{}/file/{}/", download_url.trim_end_matches('/'), config.bucket_name),
            files_count: 0,
        });
    }

    let list_data: B2ListFileNamesResponse = list_res
        .json()
        .await
        .map_err(|e| format!("Falha ao decodificar lista de arquivos: {}", e))?;

    let packages_count = list_data.files.iter().filter(|f| {
        let lower = f.file_name.to_lowercase();
        lower.ends_with(".zip") || lower.ends_with(".rar") || lower.ends_with(".tar.gz")
    }).count();

    println!(
        "[B2-TEST] Conexão validada com sucesso! Bucket ID: {}, {} arquivos inspecionados, {} pacotes.",
        resolved_bucket_id, list_data.files.len(), packages_count
    );

    Ok(B2TestConnectionResult {
        success: true,
        status: 200,
        message: format!(
            "Conexão com Backblaze B2 validada com sucesso! Bucket ID resolvido: {} ({} multitracks detectadas na amostra).",
            resolved_bucket_id, packages_count
        ),
        bucket_id: resolved_bucket_id,
        bucket_name: config.bucket_name.clone(),
        download_base_url: format!("{}/file/{}/", download_url.trim_end_matches('/'), config.bucket_name),
        files_count: packages_count,
    })
}

/// Sincronização dinâmica resiliente do catálogo Backblaze B2.
/// - Utiliza endpoint b2api/v2/b2_authorize_account compatível com respostas v2 e v3
/// - Extrai bucketId diretamente do allowed/apiInfo sem chamar b2_list_buckets (evitando erro HTTP 401 de chave restrita)
/// - Executa paginação contínua (nextFileName) em blocos de 1000
/// - Filtra estritamente pacotes .zip e .rar
#[tauri::command]
pub async fn b2_sync_catalog(
    app: AppHandle,
    key_id: Option<String>,
    application_key: Option<String>,
    bucket_id: Option<String>,
    bucket_name: Option<String>,
) -> Result<B2SyncResult, String> {
    println!("[B2-SYNC] ========================================================");
    println!("[B2-SYNC] Iniciando sincronização dinâmica do Backblaze B2...");

    let mut config = load_b2_config(&app);
    if let Some(k) = key_id {
        if !k.trim().is_empty() {
            config.key_id = k.trim().to_string();
        }
    }
    if let Some(k) = application_key {
        if !k.trim().is_empty() {
            config.application_key = k.trim().to_string();
        }
    }
    if let Some(b) = bucket_id {
        if !b.trim().is_empty() {
            config.bucket_id = b.trim().to_string();
        }
    }
    if let Some(bn) = bucket_name {
        if !bn.trim().is_empty() {
            config.bucket_name = bn.trim().to_string();
        }
    }

    // Persiste a configuração ativa
    let _ = save_b2_config(&app, &config);

    let client = reqwest::Client::builder()
        .user_agent("WorshipPlaybackPro/1.0.0 (Windows NT)")
        .build()
        .map_err(|e| format!("Falha ao inicializar cliente HTTP reqwest: {}", e))?;

    // 1. Autorização na API B2 (b2_authorize_account v2)
    println!(
        "[B2-SYNC] Autorizando conta no Backblaze B2 (Key ID: {})...",
        config.key_id
    );

    let auth_res = client
        .get("https://api.backblazeb2.com/b2api/v2/b2_authorize_account")
        .basic_auth(&config.key_id, Some(&config.application_key))
        .send()
        .await
        .map_err(|e| format!("Falha de conexão ao autorizar Backblaze B2: {}", e))?;

    if !auth_res.status().is_success() {
        let status = auth_res.status();
        let err_text = auth_res.text().await.unwrap_or_default();
        eprintln!(
            "[B2-SYNC] Erro na autorização B2 (HTTP {}): {}",
            status, err_text
        );
        return Err(format!(
            "Erro de autorização no Backblaze B2 (HTTP {}): {}",
            status, err_text
        ));
    }

    let auth_data: B2AuthorizeAccountResponse = auth_res
        .json()
        .await
        .map_err(|e| format!("Falha ao decodificar resposta de autorização B2: {}", e))?;

    let token = auth_data
        .authorization_token
        .clone()
        .ok_or_else(|| "Token de autorização não recebido do Backblaze B2".to_string())?;

    let api_url = auth_data.effective_api_url();
    let download_url = auth_data.effective_download_url();

    // 2. Resolução direta de Bucket ID (Bypass de erro 401 em chave restrita e sanitização de "WorshipAppUploader")
    let resolved_bucket_id = auth_data
        .effective_bucket_id()
        .filter(|id| is_valid_bucket_id(id))
        .or_else(|| {
            if is_valid_bucket_id(&config.bucket_id) {
                Some(config.bucket_id.clone())
            } else {
                None
            }
        })
        .unwrap_or_else(|| DEFAULT_BUCKET_ID.to_string());

    config.bucket_id = resolved_bucket_id.clone();
    let _ = save_b2_config(&app, &config);

    println!(
        "[B2-SYNC] Conta autorizada com sucesso! ApiUrl: {}, Bucket ID: {}, DownloadUrl: {}",
        api_url, resolved_bucket_id, download_url
    );

    // 3. Paginação contínua em b2_list_file_names
    let mut start_file_name: Option<String> = None;
    let mut all_files: Vec<B2FileItem> = Vec::new();
    let mut page_number = 1;

    loop {
        println!(
            "[B2-SYNC] Consultando página {} em b2_list_file_names (bucketId: {}, startFileName: {:?})...",
            page_number, resolved_bucket_id, start_file_name
        );

        let mut body = serde_json::json!({
            "bucketId": resolved_bucket_id,
            "maxFileCount": 1000
        });

        if let Some(ref s) = start_file_name {
            body["startFileName"] = serde_json::Value::String(s.clone());
        }

        let list_res = client
            .post(&format!("{}/b2api/v2/b2_list_file_names", api_url))
            .header("Authorization", &token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Falha de conexão ao listar arquivos B2: {}", e))?;

        if !list_res.status().is_success() {
            let status = list_res.status();
            let err_text = list_res.text().await.unwrap_or_default();
            eprintln!(
                "[B2-SYNC] Erro ao listar arquivos do B2 (HTTP {}): {}",
                status, err_text
            );
            return Err(format!(
                "Erro ao listar arquivos do Backblaze B2 (HTTP {}): {}",
                status, err_text
            ));
        }

        let list_data: B2ListFileNamesResponse = list_res
            .json()
            .await
            .map_err(|e| format!("Falha ao parsear b2_list_file_names: {}", e))?;

        let count_in_page = list_data.files.len();
        println!(
            "[B2-SYNC] Página {} retornou {} arquivos da API.",
            page_number, count_in_page
        );

        for file in list_data.files {
            all_files.push(file);
        }

        if let Some(next) = list_data.next_file_name {
            if !next.trim().is_empty() {
                start_file_name = Some(next);
                page_number += 1;
                continue;
            }
        }
        break;
    }

    println!(
        "[B2-SYNC] Total de arquivos varridos no bucket: {}. Filtrando pacotes de áudio (.zip e .rar)...",
        all_files.len()
    );

    // Filtra estritamente pacotes de áudio válidos (.zip, .rar, .tar.gz)
    let package_files: Vec<B2FileItem> = all_files
        .into_iter()
        .filter(|f| {
            let lower = f.file_name.to_lowercase();
            lower.ends_with(".zip") || lower.ends_with(".rar") || lower.ends_with(".tar.gz")
        })
        .collect();

    println!(
        "[B2-SYNC] Sucesso absoluto! {} multitracks prontas encontradas no bucket.",
        package_files.len()
    );
    println!("[B2-SYNC] ========================================================");

    let total_packages = package_files.len();
    let download_base_url = format!("{}/file/{}/", download_url.trim_end_matches('/'), config.bucket_name);

    Ok(B2SyncResult {
        success: true,
        bucket_name: config.bucket_name,
        bucket_id: resolved_bucket_id,
        total_files_in_bucket: total_packages,
        package_files,
        download_base_url,
        message: format!(
            "Sincronização concluída com sucesso! {} multitracks disponíveis.",
            total_packages
        ),
    })
}

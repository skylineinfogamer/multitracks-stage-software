use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use local_ip_address::list_afinet_netifas;
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, RwLock,
    },
};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RemoteServerInfo {
    pub running: bool,
    pub port: u16,
    pub ip: String,
    pub url: String,
    pub client_count: usize,
    pub qr_svg: String,
    pub available_ips: Vec<String>,
}

pub struct ServerState {
    pub tx: broadcast::Sender<String>,
    pub last_state: RwLock<String>,
    pub client_count: AtomicUsize,
    pub app_handle: AppHandle,
    pub port: u16,
    pub ip: RwLock<String>,
}

pub fn get_all_local_ips() -> Vec<String> {
    let mut ips = Vec::new();
    if let Ok(interfaces) = list_afinet_netifas() {
        for (_name, ip) in interfaces {
            if let std::net::IpAddr::V4(ipv4) = ip {
                if !ipv4.is_loopback() && !ipv4.is_link_local() {
                    let s = ipv4.to_string();
                    if !ips.contains(&s) {
                        ips.push(s);
                    }
                }
            }
        }
    }

    // Sort so 192.168.x.x comes FIRST (standard LAN / Wi-Fi), followed by 10.x.x.x, 172.x.x.x,
    // and VPN adapters (Radmin VPN 26.x.x.x, Hamachi 25.x.x.x) come LAST!
    ips.sort_by_key(|ip| {
        if ip.starts_with("192.168.") {
            0
        } else if ip.starts_with("10.") {
            1
        } else if ip.starts_with("172.") {
            2
        } else if ip.starts_with("26.") || ip.starts_with("25.") {
            10 // Radmin VPN / Hamachi
        } else {
            5
        }
    });

    if ips.is_empty() {
        ips.push("127.0.0.1".to_string());
    }
    ips
}

pub fn get_best_local_ip() -> String {
    let all = get_all_local_ips();
    all.first().cloned().unwrap_or_else(|| "127.0.0.1".to_string())
}

pub fn generate_qr_svg(url: &str) -> String {
    if let Ok(code) = QrCode::new(url.as_bytes()) {
        code.render::<svg::Color>()
            .min_dimensions(180, 180)
            .dark_color(svg::Color("#0099FF"))
            .light_color(svg::Color("#0D0E11"))
            .build()
    } else {
        String::new()
    }
}

pub async fn start_server(
    app: AppHandle,
    preferred_port: u16,
    custom_ip: Option<String>,
) -> Result<(Arc<ServerState>, tokio::sync::oneshot::Sender<()>), String> {
    let (tx, _) = broadcast::channel(128);
    let ip = match custom_ip {
        Some(cip) if !cip.is_empty() => cip,
        _ => get_best_local_ip(),
    };

    let mut bind_port = preferred_port;
    let mut listener = None;

    // Try preferred port or next available
    for p in bind_port..bind_port + 20 {
        let addr = SocketAddr::from(([0, 0, 0, 0], p));
        if let Ok(l) = tokio::net::TcpListener::bind(addr).await {
            bind_port = p;
            listener = Some(l);
            break;
        }
    }

    let listener = listener.ok_or_else(|| "Nenhuma porta TCP disponível entre 3000 e 3020".to_string())?;

    let state = Arc::new(ServerState {
        tx,
        last_state: RwLock::new(
            serde_json::json!({
                "type": "state",
                "playing": false,
                "position": 0.0,
                "duration": 0.0,
                "song": null
            })
            .to_string(),
        ),
        client_count: AtomicUsize::new(0),
        app_handle: app,
        port: bind_port,
        ip: RwLock::new(ip),
    });

    let app_router = Router::new()
        .route("/", get(serve_remote_html))
        .route("/remote", get(serve_remote_html))
        .route("/ws", get(ws_handler))
        .with_state(state.clone());

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let server_task = axum::serve(listener, app_router);

    tokio::spawn(async move {
        tokio::select! {
            _ = server_task => {},
            _ = shutdown_rx => {},
        }
    });

    Ok((state, shutdown_tx))
}

async fn serve_remote_html() -> impl IntoResponse {
    Html(include_str!("remote_client.html"))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_client_socket(socket, state))
}

async fn handle_client_socket(socket: WebSocket, state: Arc<ServerState>) {
    state.client_count.fetch_add(1, Ordering::SeqCst);
    let _ = state.app_handle.emit(
        "remote-client-change",
        serde_json::json!({ "count": state.client_count.load(Ordering::SeqCst) }),
    );

    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.tx.subscribe();

    // 1. Send initial state immediately to new client
    let init_str = {
        if let Ok(init) = state.last_state.read() {
            Some(init.clone())
        } else {
            None
        }
    };
    if let Some(init) = init_str {
        let _ = sender.send(Message::Text(init.into())).await;
    }

    // 2. Task to forward broadcast updates to this client
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // 3. Loop to receive actions from this client
    let app = state.app_handle.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                let _ = app.emit("remote-action", text.to_string());
            }
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    }

    state.client_count.fetch_sub(1, Ordering::SeqCst);
    let _ = state.app_handle.emit(
        "remote-client-change",
        serde_json::json!({ "count": state.client_count.load(Ordering::SeqCst) }),
    );
}

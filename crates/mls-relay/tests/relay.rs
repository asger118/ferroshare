use futures_util::{SinkExt, StreamExt};
use mls_proto::{PROTOCOL_VERSION, RelayMsg, Role, decode, encode};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start() -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(mls_relay::Relay::new().serve(l));
    format!("ws://{addr}")
}

async fn send(ws: &mut Ws, m: RelayMsg) {
    ws.send(Message::Binary(encode(&m).unwrap().into())).await.unwrap();
}

async fn recv(ws: &mut Ws) -> RelayMsg {
    loop {
        let m = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("timed out")
            .unwrap()
            .unwrap();
        if let Message::Binary(b) = m {
            return decode(&b).unwrap();
        }
    }
}

async fn host(url: &str) -> (Ws, String, String) {
    let (mut ws, _) = connect_async(url).await.unwrap();
    send(&mut ws, RelayMsg::CreateSession { version: PROTOCOL_VERSION, name: "host".into() }).await;
    match recv(&mut ws).await {
        RelayMsg::SessionCreated { session, token, .. } => (ws, session, token),
        m => panic!("{m:?}"),
    }
}

async fn guest(url: &str, session: &str, token: &str, name: &str) -> (Ws, RelayMsg) {
    let (mut ws, _) = connect_async(url).await.unwrap();
    send(
        &mut ws,
        RelayMsg::JoinSession {
            version: PROTOCOL_VERSION,
            session: session.into(),
            token: token.into(),
            name: name.into(),
        },
    )
    .await;
    let r = recv(&mut ws).await;
    (ws, r)
}

#[tokio::test]
async fn join_route_and_leave() {
    let url = start().await;
    let (mut h, session, token) = host(&url).await;

    let (mut g, joined) = guest(&url, &session, &token, "alice").await;
    let RelayMsg::Joined { you: alice, peers } = joined else { panic!("{joined:?}") };
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].role, Role::Host);
    let host_id = peers[0].id;
    assert!(matches!(recv(&mut h).await, RelayMsg::PeerJoined(p) if p.id == alice));

    // Broadcast guest -> host.
    send(&mut g, RelayMsg::Send { to: None, payload: b"hi".to_vec() }).await;
    assert_eq!(recv(&mut h).await, RelayMsg::Envelope { from: alice, payload: b"hi".to_vec() });

    // Direct host -> guest.
    send(&mut h, RelayMsg::Send { to: Some(alice), payload: b"yo".to_vec() }).await;
    assert_eq!(recv(&mut g).await, RelayMsg::Envelope { from: host_id, payload: b"yo".to_vec() });

    // Guest leaves -> host notified.
    drop(g);
    assert_eq!(recv(&mut h).await, RelayMsg::PeerLeft(alice));
}

#[tokio::test]
async fn wrong_token_rejected() {
    let url = start().await;
    let (_h, session, _) = host(&url).await;
    let (_, r) = guest(&url, &session, "bad", "mallory").await;
    assert_eq!(r, RelayMsg::Error("invalid invite token".into()));
}

#[tokio::test]
async fn host_leaving_ends_session() {
    let url = start().await;
    let (h, session, token) = host(&url).await;
    let (mut g, _) = guest(&url, &session, &token, "bob").await;
    drop(h);
    assert_eq!(recv(&mut g).await, RelayMsg::SessionEnded);
    let (_, r) = guest(&url, &session, &token, "late").await;
    assert!(matches!(r, RelayMsg::Error(_)));
}

#[tokio::test]
async fn version_mismatch_is_explained() {
    let url = start().await;
    let (mut ws, _) = connect_async(&url).await.unwrap();
    send(&mut ws, RelayMsg::CreateSession { version: 999, name: "x".into() }).await;
    assert!(matches!(recv(&mut ws).await, RelayMsg::Error(e) if e.contains("version mismatch")));
}

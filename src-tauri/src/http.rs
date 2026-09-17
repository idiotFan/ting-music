//! Bounded responses and deliberately isolated, redirect-free HTTP clients.
use reqwest::{Client, Response};
use std::{sync::OnceLock, time::Duration};

pub fn client() -> Result<Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT.get_or_init(|| Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(40))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build().map_err(|_| "无法初始化网络连接".into())).clone()
}

pub async fn bytes(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err("音乐服务暂不可用，请稍后重试".into());
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("音乐服务响应过大".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "音乐服务响应读取失败")? {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err("音乐服务响应过大".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub async fn json(response: Response) -> Result<serde_json::Value, String> {
    serde_json::from_slice(&bytes(response, 4 * 1024 * 1024).await?)
        .map_err(|_| "音乐服务返回了无法识别的数据".into())
}

//! QQ/WeChat QR authorization. No login URLs or cookie values are returned as errors.
use super::client::{hash33, normalize_credential, number, string, Client};
use crate::http;
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Response, Url};
use serde_json::{json, Value};

fn millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
fn cookie(response: &Response, key: &str) -> Option<String> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next()?.split_once('='))
        .find_map(|(k, v)| (k == key).then(|| v.to_string()))
}
fn location_query(value: &str, key: &str) -> Result<String, String> {
    Url::parse(value)
        .ok()
        .and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.into_owned())
        })
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "QQ 授权响应缺少必要参数".into())
}
fn capture<'a>(text: &'a str, pattern: &str) -> Result<String, String> {
    regex::Regex::new(pattern)
        .unwrap()
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "登录响应格式无法识别，请刷新二维码".into())
}
fn login_state(code: u64) -> Result<u64, String> {
    match code {
        0 | 405 => Ok(803),
        66 | 408 => Ok(801),
        67 | 404 => Ok(802),
        65 | 402 => Ok(800),
        68 | 403 => Ok(804),
        _ => Err("二维码状态无法识别，请刷新后重试".into()),
    }
}
impl Client {
    pub(super) async fn start_login(&self, kind: &str) -> Result<Value, String> {
        let kind = if kind.is_empty() { "qq" } else { kind };
        let (response, identifier, mime) = match kind {
            "qq" => {
                let response = self
                    .http
                    .get("https://ssl.ptlogin2.qq.com/ptqrshow")
                    .query(&[
                        ("appid", "716027609"),
                        ("e", "2"),
                        ("l", "M"),
                        ("s", "3"),
                        ("d", "72"),
                        ("v", "4"),
                        ("t", &format!("0.{}", millis())),
                        ("daid", "383"),
                        ("pt_3rd_aid", "100497308"),
                    ])
                    .header("Referer", "https://xui.ptlogin2.qq.com/")
                    .send()
                    .await
                    .map_err(|_| "QQ 二维码请求失败")?;
                let sig = cookie(&response, "qrsig").ok_or("QQ 二维码响应缺少标识")?;
                (response, sig, "image/png")
            }
            "wx" => {
                let response=self.http.get("https://open.weixin.qq.com/connect/qrconnect").query(&[("appid","wx48db31d50e334801"),("redirect_uri","https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/"),("response_type","code"),("scope","snsapi_login"),("state","STATE"),("href","https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect")]).send().await.map_err(|_|"微信二维码请求失败")?;
                let html = String::from_utf8(http::bytes(response, 1024 * 1024).await?)
                    .map_err(|_| "微信二维码响应格式错误")?;
                let id = capture(&html, r#"uuid=([A-Za-z0-9_-]+)"#)?;
                let response = self
                    .http
                    .get(format!("https://open.weixin.qq.com/connect/qrcode/{id}"))
                    .header("Referer", "https://open.weixin.qq.com/connect/qrconnect")
                    .send()
                    .await
                    .map_err(|_| "微信二维码图片请求失败")?;
                (response, id, "image/jpeg")
            }
            _ => return Err("登录类型无效".into()),
        };
        let image = http::bytes(response, 2 * 1024 * 1024).await?;
        if image.len() < 100 {
            return Err("二维码图片不完整，请刷新".into());
        }
        Ok(
            json!({"result":{"image":format!("data:{mime};base64,{}",STANDARD.encode(image))},"pending":{"type":kind,"identifier":identifier}}),
        )
    }
    pub(super) async fn check_login(&mut self, pending: &Value) -> Result<Value, String> {
        let identifier = string(&pending["identifier"]);
        if identifier.is_empty() {
            return Ok(json!({"result":{"code":800}}));
        }
        let credential = match string(&pending["type"]) {
            "wx" => {
                let response = self
                    .http
                    .get("https://lp.open.weixin.qq.com/connect/l/qrconnect")
                    .query(&[("uuid", identifier), ("_", &millis().to_string())])
                    .header("Referer", "https://open.weixin.qq.com/")
                    .timeout(std::time::Duration::from_secs(35))
                    .send()
                    .await;
                let response = match response {
                    Err(e) if e.is_timeout() => return Ok(json!({"result":{"code":801}})),
                    Err(_) => return Err("微信登录状态请求失败".into()),
                    Ok(r) => r,
                };
                let text = String::from_utf8(http::bytes(response, 65536).await?)
                    .map_err(|_| "微信登录响应格式错误")?;
                let code = capture(&text, r"window\.wx_errcode\s*=\s*(\d+)")?
                    .parse()
                    .map_err(|_| "微信登录状态无效")?;
                let state = login_state(code)?;
                if state != 803 {
                    return Ok(json!({"result":{"code":state}}));
                }
                let code = capture(&text, r"window\.wx_code\s*=\s*'([^']+)'")?;
                self.rpc(
                    "music.login.LoginServer",
                    "Login",
                    json!({"code":code,"strAppid":"wx48db31d50e334801"}),
                    false,
                    Some(1),
                )
                .await?
            }
            "qq" => {
                let response = self
                    .http
                    .get("https://ssl.ptlogin2.qq.com/ptqrlogin")
                    .query(&[
                        ("u1", "https://graph.qq.com/oauth2.0/login_jump"),
                        ("ptqrtoken", &hash33(identifier, 0).to_string()),
                        ("ptredirect", "0"),
                        ("h", "1"),
                        ("t", "1"),
                        ("g", "1"),
                        ("from_ui", "1"),
                        ("ptlang", "2052"),
                        ("action", &format!("0-0-{}", millis())),
                        ("js_ver", "20102616"),
                        ("js_type", "1"),
                        ("pt_uistyle", "40"),
                        ("aid", "716027609"),
                        ("daid", "383"),
                        ("pt_3rd_aid", "100497308"),
                        ("has_onekey", "1"),
                    ])
                    .header("Referer", "https://xui.ptlogin2.qq.com/")
                    .header("Cookie", format!("qrsig={identifier}"))
                    .send()
                    .await
                    .map_err(|_| "QQ 登录状态请求失败")?;
                let text = String::from_utf8(http::bytes(response, 65536).await?)
                    .map_err(|_| "QQ 登录响应格式错误")?;
                let args = parse_qq_callback(&text)?;
                let state = login_state(args[0].parse().map_err(|_| "QQ 登录状态无效")?)?;
                if state != 803 {
                    return Ok(json!({"result":{"code":state}}));
                }
                let redirect = args.get(2).ok_or("QQ 授权响应缺少跳转参数")?;
                self.authorize_qq(
                    &location_query(redirect, "uin")?,
                    &location_query(redirect, "ptsigx")?,
                )
                .await?
            }
            _ => return Err("登录类型无效".into()),
        };
        self.credential = normalize_credential(credential)?;
        Ok(
            json!({"result":{"code":803,"profile":self.profile().await},"credential":self.credential}),
        )
    }
    async fn authorize_qq(&self, uin: &str, sigx: &str) -> Result<Value, String> {
        let response = self
            .http
            .get("https://ssl.ptlogin2.graph.qq.com/check_sig")
            .query(&[
                ("uin", uin),
                ("pttype", "1"),
                ("service", "ptqrlogin"),
                ("nodirect", "0"),
                ("ptsigx", sigx),
                ("s_url", "https://graph.qq.com/oauth2.0/login_jump"),
                ("ptlang", "2052"),
                ("ptredirect", "100"),
                ("aid", "716027609"),
                ("daid", "383"),
                ("j_later", "0"),
                ("low_login_hour", "0"),
                ("regmaster", "0"),
                ("pt_login_type", "3"),
                ("pt_aid", "0"),
                ("pt_aaid", "16"),
                ("pt_light", "0"),
                ("pt_3rd_aid", "100497308"),
            ])
            .header("Referer", "https://xui.ptlogin2.qq.com/")
            .send()
            .await
            .map_err(|_| "QQ 授权验证请求失败")?;
        let key = cookie(&response, "p_skey").ok_or("QQ 授权验证失败，请重新扫码")?;
        // Explicit cookie transfer only between these two fixed QQ authorization hosts.
        let cookies: Vec<_> = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|v| v.split(';').next())
            .collect();
        let response = self
            .http
            .post("https://graph.qq.com/oauth2.0/authorize")
            .header("Cookie", cookies.join("; "))
            .form(&[
                ("response_type", "code"),
                ("client_id", "100497308"),
                (
                    "redirect_uri",
                    "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/",
                ),
                ("scope", "get_user_info,get_app_friends"),
                ("state", "state"),
                ("switch", ""),
                ("from_ptlogin", "1"),
                ("src", "1"),
                ("update_auth", "1"),
                ("openapi", "1010_1030"),
                ("g_tk", &hash33(&key, 5381).to_string()),
                ("auth_time", &millis().to_string()),
                ("ui", &uuid::Uuid::new_v4().to_string()),
            ])
            .send()
            .await
            .map_err(|_| "QQ 授权请求失败")?;
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or("QQ 授权未返回结果")?;
        let code = location_query(location, "code")?;
        self.rpc(
            "QQConnectLogin.LoginServer",
            "QQLogin",
            json!({"code":code}),
            false,
            Some(2),
        )
        .await
    }
    pub(super) async fn account(&mut self) -> Result<Value, String> {
        self.require_login()?;
        let key = string(&self.credential["musickey"]);
        let uin = self.uin();
        let response = self
            .http
            .get("https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg")
            .query(&[
                ("g_tk", hash33(key, 5381).to_string().as_str()),
                ("format", "json"),
                ("inCharset", "utf-8"),
                ("outCharset", "utf-8"),
                ("notice", "0"),
                ("cid", "205360838"),
                ("needNewCode", "0"),
                ("loginUin", &uin),
                ("hostUin", "0"),
                ("userid", &uin),
                ("reqfrom", "1"),
            ])
            .header(
                "Cookie",
                format!("uin={uin}; qqmusic_uin={uin}; qm_keyst={key}; qqmusic_key={key}"),
            )
            .send()
            .await
            .map_err(|_| "QQ 登录状态检查失败，请检查网络")?;
        let data = http::json(response).await?;
        let code = data["code"].as_i64().ok_or("QQ 登录状态响应格式错误")?;
        if code != 0 {
            let c = &self.credential;
            let kind = number(&c["login_type"]);
            let mut param = json!({"openid":string(&c["openid"]),"refresh_token":string(&c["refresh_token"]),"musickey":key,"refresh_key":string(&c["refresh_key"]),"loginMode":2});
            if kind == 1 {
                param["str_musicid"] = json!(uin);
                param["unionid"] = json!(string(&c["unionid"]));
            } else {
                param["access_token"] = json!(string(&c["access_token"]));
                param["expired_in"] = json!(number(&c["expired_at"]));
                param["musicid"] = json!(number(&c["musicid"]));
                if kind != 2 {
                    param["str_musicid"] = json!(uin);
                    param["unionid"] = json!(string(&c["unionid"]));
                }
            }
            // A temporary network error must never destroy the saved session.
            match self
                .rpc("music.login.LoginServer", "Login", param, false, Some(kind))
                .await
            {
                Ok(c) => self.credential = normalize_credential(c)?,
                Err(e) if e.starts_with("QQ 登录已过期，请重新扫码") => {
                    return Ok(json!({"result":null,"expired":true}))
                }
                Err(e) => return Err(e),
            }
        }
        Ok(json!({"result":self.profile().await,"credential":self.credential}))
    }
}
fn parse_qq_callback(text: &str) -> Result<Vec<String>, String> {
    let body = capture(text, r"ptuiCB\((.*?)\)")?;
    let args: Vec<_> = regex::Regex::new(r"'((?:\\.|[^'])*)'")
        .unwrap()
        .captures_iter(&body)
        .map(|c| c[1].replace("\\'", "'"))
        .collect();
    if args.is_empty() {
        Err("QQ 登录状态响应无效".into())
    } else {
        Ok(args)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_and_status_contract() {
        assert_eq!(
            parse_qq_callback("ptuiCB('66','0','','0','waiting','');").unwrap()[0],
            "66"
        );
        for (a, b) in [
            (66, 801),
            (408, 801),
            (67, 802),
            (404, 802),
            (65, 800),
            (402, 800),
            (68, 804),
            (403, 804),
            (0, 803),
            (405, 803),
        ] {
            assert_eq!(login_state(a).unwrap(), b);
        }
        assert!(login_state(9).is_err());
        assert!(parse_qq_callback("unexpected response").is_err());
    }
    #[test]
    fn authorization_query_is_not_order_dependent() {
        assert_eq!(
            location_query("https://y.qq.com/redirect?state=state&code=test", "code").unwrap(),
            "test"
        );
    }
}

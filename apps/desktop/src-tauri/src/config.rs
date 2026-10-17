pub fn api_url() -> &'static str {
    option_env!("KUKU_API_URL").unwrap_or(if cfg!(debug_assertions) {
        "http://localhost:8080"
    } else {
        "https://api.kuku.mom"
    })
}

pub fn web_url() -> &'static str {
    option_env!("KUKU_WEB_URL").unwrap_or(if cfg!(debug_assertions) {
        "http://localhost:4321"
    } else if api_url() == "https://preview-api.kuku.mom" {
        "https://preview.kuku.mom"
    } else {
        "https://www.kuku.mom"
    })
}

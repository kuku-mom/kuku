use unicode_normalization::UnicodeNormalization;

pub fn normalize_path(path: &str) -> String {
    let normalized = path.replace('\\', "/").nfc().collect::<String>();
    normalized
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_and_separator_normalization_are_stable() {
        assert_eq!(normalize_path("Notes\\Cafe\u{301}.md"), "notes/café.md");
    }
}

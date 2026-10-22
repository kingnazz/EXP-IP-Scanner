//! Curated signals only. Remote scripts, cookies and full bodies never cross IPC.
use crate::models::{Confidence, Technology};
use regex::Regex;
use scraper::{Html, Selector};
use std::{collections::BTreeMap, sync::OnceLock};

pub fn clean(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(*c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(max)
        .collect::<String>()
        .trim()
        .into()
}
fn attr_values(doc: &Html, selector: &str, attr: &str) -> Vec<String> {
    doc.select(&Selector::parse(selector).expect("static selector"))
        .filter_map(|e| e.value().attr(attr))
        .take(128)
        .filter_map(|s| {
            reqwest::Url::parse("http://scanner.invalid/")
                .ok()?
                .join(s)
                .ok()
        })
        .map(|url| url.path().to_ascii_lowercase())
        .collect()
}
fn release(value: &str, marker: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let start = lower.find(marker)? + marker.len();
    let raw: String = value[start..]
        .chars()
        .skip_while(|c| *c == '/' || c.is_whitespace())
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '~' | ':'))
        .take(80)
        .collect();
    raw.chars()
        .next()
        .filter(|c| c.is_ascii_digit())
        .map(|_| raw)
}
pub struct Fingerprints {
    pub title: Option<String>,
    pub technologies: Vec<Technology>,
    pub admin_interfaces: Vec<String>,
}
pub fn detect(headers: &BTreeMap<String, String>, body: &str) -> Fingerprints {
    let doc = Html::parse_document(body);
    let title = doc
        .select(&Selector::parse("title").unwrap())
        .next()
        .map(|e| clean(&e.text().collect::<String>(), 160))
        .filter(|s| !s.is_empty());
    let title_lower = title.as_deref().unwrap_or("").to_ascii_lowercase();
    let generators: Vec<_> = doc
        .select(&Selector::parse("meta[name]").unwrap())
        .filter(|e| {
            e.value()
                .attr("name")
                .is_some_and(|n| n.eq_ignore_ascii_case("generator"))
        })
        .filter_map(|e| e.value().attr("content"))
        .take(16)
        .map(|s| clean(s, 160))
        .collect();
    let assets = attr_values(&doc, "script[src], img[src]", "src")
        .into_iter()
        .chain(attr_values(&doc, "link[href]", "href"))
        .collect::<Vec<_>>();
    let actions = attr_values(&doc, "form[action]", "action");
    let mut tech = vec![];
    let mut admins = vec![];
    let server = headers.get("server").map(String::as_str).unwrap_or("");
    let powered = headers
        .get("x-powered-by")
        .map(String::as_str)
        .unwrap_or("");
    for (product, token) in [
        ("Apache", "apache"),
        ("nginx", "nginx"),
        ("IIS", "microsoft-iis"),
    ] {
        if server
            .to_ascii_lowercase()
            .split_whitespace()
            .any(|s| s == token || s.starts_with(&format!("{token}/")))
        {
            tech.push(Technology {
                product: product.into(),
                version: release(server, token),
                confidence: Confidence::High,
                evidence: vec![format!("Server header identifies {product}")],
            });
        }
    }
    let dsm_asset = assets
        .iter()
        .any(|s| s.contains("/webman/") || s.contains("synology") && s.contains(".js"));
    let dsm_title = title_lower.contains("synology")
        || title_lower.contains("diskstation")
        || title_lower == "dsm";
    let dsm_metadata = generators
        .iter()
        .any(|s| s.to_ascii_lowercase().contains("synology"))
        || headers.get("x-synology").is_some();
    let signals = usize::from(dsm_asset) + usize::from(dsm_title) + usize::from(dsm_metadata);
    if signals > 0 {
        let mut evidence = vec![];
        if dsm_asset {
            evidence.push("DSM-specific webman/Synology asset path".into());
        }
        if dsm_title {
            evidence.push("Synology/DSM page title".into());
        }
        if dsm_metadata {
            evidence.push("Synology response metadata".into());
        }
        tech.push(Technology {
            product: "Synology DSM".into(),
            version: None,
            confidence: if signals >= 2 {
                Confidence::High
            } else {
                Confidence::Low
            },
            evidence,
        });
        if signals >= 2 {
            admins.push("Synology DSM".into());
        }
    }
    for (product, generator, asset, login) in [
        ("WordPress", "wordpress", "/wp-content/", "wp-login.php"),
        ("Drupal", "drupal", "/sites/default/", "user/login"),
        (
            "Joomla",
            "joomla",
            "/media/system/",
            "administrator/index.php",
        ),
        ("Nextcloud", "nextcloud", "/core/js/", "/login"),
        ("phpMyAdmin", "phpmyadmin", "/themes/pmahomme/", "index.php"),
    ] {
        let meta = generators
            .iter()
            .find(|s| s.to_ascii_lowercase().starts_with(generator));
        let has_asset = assets.iter().any(|s| {
            s.contains(asset)
                || (product == "WordPress"
                    && (s.contains("/wp-admin/") || s.contains("/wp-includes/")))
        });
        let named_title = title_lower.contains(generator);
        let count = usize::from(meta.is_some()) + usize::from(has_asset) + usize::from(named_title);
        if count == 0 {
            continue;
        }
        // A title alone is not sufficient to assert a PHP application.
        if meta.is_none() && !has_asset {
            continue;
        }
        let mut evidence = vec![];
        if meta.is_some() {
            evidence.push(format!("{product} generator metadata"));
        }
        if has_asset {
            evidence.push(format!("{product}-specific asset path"));
        }
        if named_title {
            evidence.push(format!("{product} page title"));
        }
        tech.push(Technology {
            product: product.into(),
            version: meta.and_then(|s| release(s, generator)),
            confidence: if count >= 2 {
                Confidence::High
            } else {
                Confidence::Medium
            },
            evidence,
        });
        if count >= 2 && (actions.iter().any(|a| a.contains(login)) || product == "phpMyAdmin") {
            admins.push(product.into());
        }
    }
    if title_lower.contains("webmin") && actions.iter().any(|a| a.ends_with("/session_login.cgi")) {
        tech.push(Technology {
            product: "Webmin".into(),
            version: None,
            confidence: Confidence::High,
            evidence: vec!["Webmin title and session_login.cgi form".into()],
        });
        admins.push("Webmin".into());
    }
    if title_lower.contains("web station")
        && assets
            .iter()
            .any(|s| s.contains("synology") || s.contains("webstation"))
    {
        tech.push(Technology {
            product: "Synology Web Station".into(),
            version: None,
            confidence: Confidence::High,
            evidence: vec!["Web Station title and Synology/WebStation asset".into()],
        });
    }
    static PHP: OnceLock<Regex> = OnceLock::new();
    let php_re = PHP.get_or_init(|| {
        Regex::new(
            r"(?i)(?:^|[\s;,])PHP(?:-FPM)?(?:/([0-9][0-9A-Za-z.+~:\-]{0,79}))?(?:$|[\s;,()])",
        )
        .unwrap()
    });
    let header_php = [powered, server].iter().find_map(|s| php_re.captures(s));
    let php_app = tech.iter().any(|t| {
        matches!(
            t.product.as_str(),
            "WordPress" | "Drupal" | "Joomla" | "Nextcloud" | "phpMyAdmin"
        )
    });
    let php_action = actions
        .iter()
        .any(|a| a.split('?').next().is_some_and(|a| a.ends_with(".php")));
    if header_php.is_some() || php_app || php_action {
        let mut evidence = vec![];
        if header_php.is_some() {
            evidence.push("PHP-related Server or X-Powered-By header".into());
        }
        if php_app {
            evidence.push("Recognizable PHP application serves this HTTP response".into());
        }
        if php_action {
            evidence.push("HTML form targets a .php endpoint (weak indicator)".into());
        }
        tech.push(Technology {
            product: "PHP".into(),
            version: header_php
                .as_ref()
                .and_then(|c| c.get(1))
                .map(|v| v.as_str().into()),
            confidence: if header_php.is_some() {
                Confidence::High
            } else if php_app {
                Confidence::Medium
            } else {
                Confidence::Low
            },
            evidence,
        });
    }
    if [powered, server]
        .iter()
        .any(|s| s.to_ascii_lowercase().contains("php-fpm"))
    {
        tech.push(Technology {
            product: "PHP-FPM".into(),
            version: None,
            confidence: Confidence::Medium,
            evidence: vec!["Explicit PHP-FPM HTTP header indicator".into()],
        });
    }
    Fingerprints {
        title,
        technologies: tech,
        admin_interfaces: admins,
    }
}

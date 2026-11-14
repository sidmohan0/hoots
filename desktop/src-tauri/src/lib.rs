use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

/// The desktop shell is a window onto the local perch plus the parts a browser
/// tab can't give an always-on agent: a tray presence, close-to-tray, a single
/// instance, and a deep-link scheme for heralds.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Show Parliament", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?;
            let telegram = MenuItem::with_id(app, "telegram", "Open Telegram", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Hoots", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &reload, &telegram, &quit])?;

            let _tray = TrayIconBuilder::with_id("presence")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("Hoots")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "reload" => {
                        show_main(app);
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("location.reload()");
                        }
                    }
                    "telegram" => {
                        let url = std::env::var("HOOTS_TELEGRAM_URL")
                            .unwrap_or_else(|_| "https://t.me/sid_hoots_bot".into());
                        let _ = tauri_plugin_opener::open_url(url, None::<&str>);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        // Close-to-tray: an always-on agent shouldn't die when you close the window.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main<R: tauri::Runtime, M: Manager<R>>(app: &M) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

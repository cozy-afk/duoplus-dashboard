use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Spawn the Bun backend sidecar.
            // The sidecar binary is compiled via: bun build --compile server.ts --outfile src-tauri/binaries/server-bin
            let sidecar = handle
                .shell()
                .sidecar("server-bin")
                .expect("server-bin sidecar not found — run `bun run build:server` first");

            let (mut _rx, _child) = sidecar
                .spawn()
                .expect("Failed to start backend sidecar");

            // Give the server a moment to bind its port, then open the window.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Duoplus dashboard");
}

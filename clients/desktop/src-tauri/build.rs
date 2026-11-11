fn main() {
    // The bundled Agent carries a platform-specific Node runtime and native dependencies
    // (Mach-O on macOS, PE on Windows). Refuse to silently ship them inside an installer
    // for any other target.
    const SUPPORTED_TARGETS: [&str; 2] = ["aarch64-apple-darwin", "x86_64-pc-windows-msvc"];
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && !std::env::var("TARGET")
            .is_ok_and(|target| SUPPORTED_TARGETS.contains(&target.as_str()))
    {
        panic!("The bundled Agent requires aarch64-apple-darwin or x86_64-pc-windows-msvc. Import a matching Agent package and update the platform integration before building another target.");
    }
    tauri_build::build()
}

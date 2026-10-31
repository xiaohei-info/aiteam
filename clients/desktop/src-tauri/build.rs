fn main() {
    // The supplied Node runtime and native dependencies are ARM64 Mach-O files.
    // Refuse to silently ship them inside an Intel/Windows installer.
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var("TARGET").as_deref() != Ok("aarch64-apple-darwin")
    {
        panic!("The bundled Agent requires aarch64-apple-darwin. Import a matching Agent package and update the platform integration before building another target.");
    }
    tauri_build::build()
}

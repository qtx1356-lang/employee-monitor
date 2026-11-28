# Employee Monitor - ETW file monitoring prototype

This is a separate, local-only proof of concept. It does not replace the existing Employee Monitor agent and does not upload anything to Cloudflare.

## What it tests

- Windows kernel ETW file-I/O events.
- File-object correlation between a file create/open event and the later cleanup event.
- Separate records for distinct file-object opens, including reopening the same path.
- Multiple files open at the same time.
- Full paths when Windows ETW supplies a resolved path.
- Process name, process ID, UTC timestamps and elapsed handle-open duration.

The prototype deliberately does not read file contents, capture keystrokes, take screenshots, or inspect document text.

## Build

The GitHub Actions workflow `.github/workflows/build-file-monitor-prototype.yml` builds a self-contained Windows x64 executable and publishes it as an artifact.

## Test

1. Download and extract the `EmployeeMonitor-FileMonitor-Test.exe` artifact from the successful workflow run.
2. Right-click it and choose **Run as administrator**.
3. Open and close a few test files in Notepad, Word, Excel and a PDF reader.
4. Reopen one file and open two files at the same time.
5. Stop the test application with Ctrl+C.
6. Inspect `C:\ProgramData\EmployeeMonitor\file-monitor-test\file-events.jsonl`.

## Important interpretation

This measures Windows file-object handle lifetime, not the time a document is visible or actively edited. An application can keep a handle open after its document window is closed, and background components can open files. ETW cleanup is emitted when the last handle to that file object is released. Some file paths or operations may not be resolved or observed if ETW events are lost or the trace session cannot start.

This prototype must pass real Windows tests before it is connected to the production agent or dashboard. Starting the kernel ETW session requires administrator rights, but it does not install a custom kernel driver.

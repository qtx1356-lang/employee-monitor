using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;
using Microsoft.Diagnostics.Tracing.Session;

namespace EmployeeMonitor.FileMonitorPrototype;

internal sealed record OpenRecord(
    ulong FileObject,
    int ProcessId,
    string ProcessName,
    string FilePath,
    DateTime OpenedUtc);

internal static class Program
{
    private static readonly ConcurrentDictionary<ulong, OpenRecord> OpenFiles = new();
    private static readonly ConcurrentDictionary<(ulong FileObject, string Operation), byte> LoggedIo = new();
    private static readonly object WriteLock = new();
    private static string LogPath = "";

    private static int Main()
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("This prototype supports Windows 10/11 only.");
            return 2;
        }

        if (!IsAdministrator())
        {
            Console.Error.WriteLine("Administrator permission is required to start the Windows kernel ETW file-I/O session.");
            Console.Error.WriteLine("Right-click the application and choose Run as administrator.");
            return 5;
        }

        var folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "EmployeeMonitor", "file-monitor-test");
        Directory.CreateDirectory(folder);
        LogPath = Path.Combine(folder, "file-events.jsonl");

        Console.WriteLine("Employee Monitor - ETW file monitoring prototype");
        Console.WriteLine("This test records file paths, process names, process IDs and open/close timestamps only.");
        Console.WriteLine("It does not read file contents.");
        Console.WriteLine($"Log: {LogPath}");
        Console.WriteLine("Press Ctrl+C to stop.");

        try
        {
            using var session = new TraceEventSession(KernelTraceEventParser.KernelSessionName);
            session.StopOnDispose = true;
            session.EnableKernelProvider(
                KernelTraceEventParser.Keywords.DiskFileIO |
                KernelTraceEventParser.Keywords.FileIO |
                KernelTraceEventParser.Keywords.FileIOInit);

            // FileIOCreate carries the path directly in its FileName payload.
            // FileIOName uses FileKey (a name-table key), not FileObject, so do
            // not incorrectly correlate those two identifiers.
            session.Source.Kernel.FileIOCreate += OnFileOpen;
            session.Source.Kernel.FileIORead += OnFileRead;
            session.Source.Kernel.FileIOWrite += OnFileWrite;
            session.Source.Kernel.FileIOCleanup += OnFileCleanup;

            Console.WriteLine("ETW session started. Open and close test documents now.");
            session.Source.Process();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"ETW could not start: {ex.GetType().Name}: {ex.Message}");
            Console.Error.WriteLine("Another kernel trace session may be active, or Windows may have denied ETW access.");
            return 1;
        }
    }

    private static void OnFileOpen(FileIOCreateTraceData data)
    {
        try
        {
            var fileObject = data.FileObject;
            if (fileObject == 0)
                return;
            // FileIOCreateTraceData exposes the create-event path as FileName.
            var path = data.FileName;
            if (string.IsNullOrWhiteSpace(path))
            {
                Write(new { event_type = "file_open_unresolved", file_object = $"0x{fileObject:X}", process_id = data.ProcessID, app_name = SafeProcessName(data.ProcessID, data.ProcessName), occurred_at = data.TimeStamp.ToUniversalTime() });
                return;
            }

            // Ignore directory handles, but do not restrict file extensions or folders.
            if ((((int)data.CreateOptions) & 0x1) != 0 ||
                (((int)data.FileAttributes) & (int)FileAttributes.Directory) != 0)
                return;

            var record = new OpenRecord(
                fileObject,
                data.ProcessID,
                SafeProcessName(data.ProcessID, data.ProcessName),
                path,
                data.TimeStamp.ToUniversalTime());

            if (OpenFiles.TryAdd(fileObject, record))
            {
                Write(new
                {
                    event_type = "file_open",
                    file_object = $"0x{fileObject:X}",
                    process_id = record.ProcessId,
                    app_name = record.ProcessName,
                    file_path = record.FilePath,
                    occurred_at = record.OpenedUtc
                });
            }
        }
        catch (Exception ex)
        {
            Write(new { event_type = "diagnostic_error", message = ex.Message, occurred_at = DateTime.UtcNow });
        }
    }

    // Read/write events provide a second path-resolution signal. Log only the first
    // read and first write for each file object to keep this diagnostic log bounded.
    private static void OnFileRead(FileIOReadWriteTraceData data) => LogFileIo(data, "file_read_activity");

    private static void OnFileWrite(FileIOReadWriteTraceData data) => LogFileIo(data, "file_write_activity");

    private static void LogFileIo(FileIOReadWriteTraceData data, string eventType)
    {
        try
        {
            var fileObject = data.FileObject;
            var path = data.FileName;
            if (fileObject == 0 || string.IsNullOrWhiteSpace(path))
                return;

            var operation = eventType == "file_read_activity" ? "read" : "write";
            if (!LoggedIo.TryAdd((fileObject, operation), 0))
                return;

            Write(new
            {
                event_type = eventType,
                file_object = $"0x{fileObject:X}",
                process_id = data.ProcessID,
                app_name = SafeProcessName(data.ProcessID, data.ProcessName),
                file_path = path,
                io_size = data.IoSize,
                occurred_at = data.TimeStamp.ToUniversalTime()
            });
        }
        catch (Exception ex)
        {
            Write(new { event_type = "diagnostic_error", message = ex.Message, occurred_at = DateTime.UtcNow });
        }
    }

    private static void OnFileCleanup(FileIOSimpleOpTraceData data)
    {
        try
        {
            var fileObject = data.FileObject;
            if (fileObject == 0)
                return;
            LoggedIo.TryRemove((fileObject, "read"), out _);
            LoggedIo.TryRemove((fileObject, "write"), out _);
            if (!OpenFiles.TryRemove(fileObject, out var record))
                return;

            Write(new
            {
                event_type = "file_close",
                file_object = $"0x{fileObject:X}",
                process_id = record.ProcessId,
                app_name = record.ProcessName,
                file_path = record.FilePath,
                opened_at = record.OpenedUtc,
                occurred_at = data.TimeStamp.ToUniversalTime(),
                duration_seconds = Math.Max(0, (data.TimeStamp.ToUniversalTime() - record.OpenedUtc).TotalSeconds)
            });
        }
        catch (Exception ex)
        {
            Write(new { event_type = "diagnostic_error", message = ex.Message, occurred_at = DateTime.UtcNow });
        }
    }

    private static string SafeProcessName(int processId, string? traceName)
    {
        if (!string.IsNullOrWhiteSpace(traceName))
            return traceName;
        try { return Process.GetProcessById(processId).ProcessName; }
        catch { return "unknown"; }
    }

    private static void Write(object item)
    {
        try
        {
            var line = JsonSerializer.Serialize(item);
            lock (WriteLock)
                File.AppendAllText(LogPath, line + Environment.NewLine);
            Console.WriteLine(line);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Could not write event log: {ex.Message}");
        }
    }

    private static bool IsAdministrator()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }
}

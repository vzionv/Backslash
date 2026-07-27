import { spawn, ChildProcess } from "child_process";

/**
 * WindowsProcessTreeManager
 *
 * Manages process tree lifecycle on Windows.
 * On non-Windows platforms, uses POSIX process group signals.
 *
 * The key challenge: killing only the parent process (latexmk)
 * may leave orphaned xelatex, biber, makeindex processes running.
 * On Windows, taskkill /T ensures the entire tree is terminated.
 */
export class WindowsProcessTreeManager {
  /**
   * Kill an entire process tree.
   *
   * @param pid - The root process ID to kill.
   * @returns true if the kill command was dispatched successfully.
   */
  static killTree(pid: number): boolean {
    if (process.platform === "win32") {
      return WindowsProcessTreeManager.killTreeWindows(pid);
    }
    return WindowsProcessTreeManager.killTreePosix(pid);
  }

  /**
   * Kill via child_process.on("close") reference.
   */
  static killChildProcess(proc: ChildProcess): void {
    if (!proc.pid) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      return;
    }

    if (process.platform === "win32") {
      WindowsProcessTreeManager.killTreeWindows(proc.pid);
    } else {
      WindowsProcessTreeManager.killTreePosix(proc.pid);
    }
  }

  private static killTreeWindows(pid: number): boolean {
    try {
      const killer = spawn(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        }
      );

      killer.on("error", (err: NodeJS.ErrnoException) => {
        console.warn(`[ProcessTree] taskkill error for PID ${pid}: ${err.message}`);
      });

      killer.on("close", (code: number | null) => {
        if (code !== 0 && code !== 128) {
          // code 128 means the process already exited, which is fine
          console.warn(
            `[ProcessTree] taskkill for PID ${pid} exited with code ${code}`
          );
        }
      });

      return true;
    } catch (err) {
      console.error(
        `[ProcessTree] Failed to spawn taskkill: ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }

  private static killTreePosix(pid: number): boolean {
    try {
      // Send SIGTERM to the process group
      process.kill(-pid, "SIGTERM");

      // Force kill after 3 seconds
      const forceTimeout = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Process already gone
        }
      }, 3000);

      // Don't let the timer keep the event loop alive
      if (forceTimeout.unref) {
        forceTimeout.unref();
      }

      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // Process doesn't exist — that's fine
        return true;
      }
      console.warn(
        `[ProcessTree] Failed to kill POSIX process group ${pid}: ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }
}

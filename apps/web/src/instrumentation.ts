export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { startWebInternalServer } = await import(
        "@/lib/realtime/web-internal-server"
      );
      startWebInternalServer();
    } catch (err) {
      console.error(
        "[Instrumentation] Failed to start internal server:",
        err instanceof Error ? err.message : err
      );
    }

    const runInWeb = process.env.RUN_COMPILE_RUNNER_IN_WEB !== "false";

    if (runInWeb) {
      try {
        // Environment check
        const { checkEnvironment } = await import(
          "@/lib/compiler/environment-check"
        );
        const envResult = await checkEnvironment();
        if (!envResult.ok) {
          console.error(
            "[Instrumentation] Environment check failed — compilation may not work:"
          );
          for (const err of envResult.errors) {
            console.error(`  - ${err}`);
          }
        }

        // Start native compile runner
        const { startCompileRunner } = await import("@/lib/compiler/runner");
        const { startAsyncCompileRunner } = await import(
          "@/lib/compiler/asyncCompileRunner"
        );
        startCompileRunner();
        startAsyncCompileRunner();
        console.log("[Instrumentation] Native compile runners started");
      } catch (err) {
        console.error(
          "[Instrumentation] Failed to start compile runners:",
          err instanceof Error ? err.message : err
        );
      }
    } else {
      console.log(
        "[Instrumentation] Compile runner disabled in web (RUN_COMPILE_RUNNER_IN_WEB=false)"
      );
    }
  }
}

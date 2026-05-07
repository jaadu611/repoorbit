import { execSync, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Sandbox Executor for Repoorbit
 * Usage: node sandbox_executor.mjs <source_repo_dir_or_url> [test_command]
 */

const source = process.argv[2];
const testCmd = process.argv[3] || "npm test";

if (!source) {
    console.error("Usage: node sandbox_executor.mjs <source_repo_dir_or_url> [test_command]");
    process.exit(1);
}

const sandboxId = `repoorbit_sandbox_${Date.now()}`;
const sandboxDir = path.join(os.tmpdir(), sandboxId);

async function run() {
    console.log(`[SANDBOX] Initializing isolated environment in: ${sandboxDir}`);
    
    // 1. Create Sandbox Directory
    fs.mkdirSync(sandboxDir, { recursive: true });

    // 2. Obtain Source
    if (source.startsWith("http") || source.includes("github.com")) {
        console.log(`[SANDBOX] Cloning repository directly into sandbox: ${source}`);
        try {
            execSync(`git clone --depth 1 ${source} .`, { cwd: sandboxDir, stdio: 'inherit' });
        } catch (e) {
            console.error("[SANDBOX] Clone failed:", e.message);
            process.exit(1);
        }
    } else {
        const absSourceDir = path.resolve(source);
        if (!fs.existsSync(absSourceDir)) {
            console.error(`Error: Source directory ${absSourceDir} does not exist.`);
            process.exit(1);
        }
        console.log(`[SANDBOX] Copying project files from ${absSourceDir}...`);
        try {
            execSync(`cp -R "${absSourceDir}/." "${sandboxDir}/"`);
            // Clean up unwanted folders
            ['node_modules', '.git', '.next', '.turbo', 'dist'].forEach(dir => {
                const p = path.join(sandboxDir, dir);
                if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
            });
        } catch (e) {
            console.error("[SANDBOX] Copy failed:", e.message);
            process.exit(1);
        }
    }

    // 3. Script Validation
    const pkgPath = path.join(sandboxDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const availableScripts = Object.keys(pkg.scripts || {});
        
        if (testCmd.startsWith("npm run ")) {
            const scriptName = testCmd.replace("npm run ", "");
            if (!availableScripts.includes(scriptName)) {
                console.warn(`\n[SANDBOX] ⚠️  Warning: Script "${scriptName}" not found in package.json.`);
                console.log(`[SANDBOX] Available scripts: ${availableScripts.join(', ') || 'None'}`);
                console.log(`[SANDBOX] Defaulting to: npm test`);
            }
        }
    }

    // 4. Install Essentials
    console.log(`[SANDBOX] Installing project dependencies... (using --prefer-offline)`);
    try {
        execSync(`npm install --no-audit --no-fund --loglevel=error --prefer-offline`, { 
            cwd: sandboxDir, 
            stdio: 'inherit',
            env: { ...process.env, NODE_ENV: 'development' }
        });
    } catch (err) {
        console.warn("\n[SANDBOX] ⚠️  npm install had issues. Continuing to test phase...");
    }

    // 5. Run Tests
    console.log(`\n[SANDBOX] Executing: ${testCmd}`);
    console.log("--------------------------------------------------");
    const testResult = spawnSync(testCmd, { 
        shell: true, 
        cwd: sandboxDir, 
        stdio: 'inherit',
        env: { ...process.env, CI: 'true', SANDBOX: 'true' }
    });
    console.log("--------------------------------------------------");

    // 6. Reporting
    if (testResult.status === 0) {
        console.log("\n[SANDBOX] ✅ SUCCESS: All tests passed.");
    } else {
        console.error(`\n[SANDBOX] ❌ FAILURE: Command exited with code ${testResult.status}.`);
    }

    console.log(`\n[SANDBOX] PERSISTENCE: This sandbox will NOT be deleted.`);
    console.log(`[SANDBOX] Location: ${sandboxDir}`);
    console.log(`[SANDBOX] Done.`);
}

run().catch(err => {
    console.error("[SANDBOX] Critical Error:", err.message);
    process.exit(1);
});

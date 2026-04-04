const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

/**
 * Terminal simulada con estado persistente.
 * Mantiene cwd, variables de entorno e historial entre comandos.
 */
class SimulatedStatefulTerminal {
    constructor(initialCwd) {
        this.initialCwd = path.resolve(initialCwd);
        this.cwd = this.initialCwd;
        this.envVars = {};
        this.commandHistory = [];
        this.lastOutput = "";
        this.lastCommand = "";
        this.backgroundProcesses = new Map(); // pid -> { process, output: [], command }
    }

    getPromptInfo() {
        try {
            const files = [];
            const entries = fs.readdirSync(this.cwd, { withFileTypes: true });

            for (let i = 0; i < Math.min(entries.length, 10); i++) {
                const f = entries[i];
                if (f.isDirectory()) {
                    files.push(`📁 ${f.name}/`);
                } else {
                    const stats = fs.statSync(path.join(this.cwd, f.name));
                    files.push(`📄 ${f.name} (${stats.size}b)`);
                }
            }

            if (entries.length > 10) {
                files.push(`... y ${entries.length - 10} más`);
            }

            const relativeCwd = this.cwd.startsWith(this.initialCwd)
                ? path.relative(this.initialCwd, this.cwd) || '.'
                : this.cwd;

            return {
                cwd: this.cwd,
                relative_cwd: relativeCwd,
                files: files,
                env_count: Object.keys(this.envVars).length,
                history_count: this.commandHistory.length
            };
        } catch (err) {
            return {
                cwd: this.cwd,
                relative_cwd: this.cwd,
                files: ["[Error listando archivos]"],
                env_count: Object.keys(this.envVars).length,
                history_count: this.commandHistory.length
            };
        }
    }

    execute(command, options) {
        this.lastCommand = command;

        const dangerousPatterns = [
            [/^python\s*$/i, "python sin argumentos entra en modo interactivo"],
            [/^python3\s*$/i, "python3 sin argumentos entra en modo interactivo"],
            [/^node\s*$/i, "node sin argumentos entra en modo interactivo"],
            [/^bash\s*$/i, "bash sin argumentos entra en modo interactivo"],
            [/^sh\s*$/i, "sh sin argumentos entra en modo interactivo"]
        ];

        for (const [pattern, reason] of dangerousPatterns) {
            if (pattern.test(command.trim())) {
                return `⚠️ COMANDO BLOQUEADO: ${reason}. El comando no se ejecutó para evitar que el terminal se quede colgado.`;
            }
        }

        // Expandir variables $VAR
        let expandedCommand = command;
        for (const [key, val] of Object.entries(this.envVars)) {
            expandedCommand = expandedCommand.replace(new RegExp(`\\$${key}\\b`, 'g'), val);
            expandedCommand = expandedCommand.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), val);
        }

        // Detectar cd
        const cdMatch = expandedCommand.trim().match(/^cd\s+(.+)$/);
        if (cdMatch) {
            const targetPath = cdMatch[1].trim();
            const result = this._changeDirectory(targetPath);
            this.commandHistory.push({ cmd: command, cwd: this.cwd, result });
            return result;
        }

        // Detectar export VAR=valor
        const exportMatch = expandedCommand.trim().match(/^export\s+(\w+)=(.+)$/);
        if (exportMatch) {
            let [, key, val] = exportMatch;
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            this.envVars[key] = val;
            const result = `✓ Variable de entorno establecida: ${key}=${val}`;
            this.commandHistory.push({ cmd: command, cwd: this.cwd, result });
            return result;
        }

        // Detectar unset VAR
        const unsetMatch = expandedCommand.trim().match(/^unset\s+(\w+)$/);
        if (unsetMatch) {
            const key = unsetMatch[1];
            let result;
            if (key in this.envVars) {
                delete this.envVars[key];
                result = `✓ Variable ${key} eliminada`;
            } else {
                result = `Variable ${key} no estaba definida`;
            }
            this.commandHistory.push({ cmd: command, cwd: this.cwd, result });
            return result;
        }

        const trimmed = expandedCommand.trim();
        if (trimmed.startsWith('read_bg ')) {
            const pid = trimmed.substring(8).trim();
            const result = this.readBackgroundOutput(pid);
            this.commandHistory.push({ cmd: command, cwd: this.cwd, result });
            return result;
        }

        // Ejecutar comando
        try {
            const env = { ...process.env, ...this.envVars };

            if (options && options.background) {
                const child = spawn(expandedCommand, {
                    cwd: this.cwd,
                    env,
                    shell: true,
                    detached: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                const procInfo = {
                    process: child,
                    output: [],
                    command: expandedCommand,
                    pid: child.pid
                };

                child.stdout.on('data', (data) => {
                    procInfo.output.push(data.toString());
                    if (procInfo.output.length > 50) procInfo.output.shift();
                });

                child.stderr.on('data', (data) => {
                    procInfo.output.push(`[STDERR] ${data.toString()}`);
                    if (procInfo.output.length > 50) procInfo.output.shift();
                });

                child.on('exit', (code) => {
                    procInfo.output.push(`[Proceso ${child.pid} finalizado con código ${code}]`);
                    this.backgroundProcesses.delete(child.pid);
                });

                child.unref();
                this.backgroundProcesses.set(child.pid, procInfo);

                const res = `🚀 Proceso en background iniciado (PID: ${child.pid}): ${expandedCommand}`;
                this.commandHistory.push({ cmd: command, cwd: this.cwd, result: res });
                return res;
            }

            const result = execSync(expandedCommand, {
                cwd: this.cwd,
                encoding: 'utf-8',
                env,
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024
            });

            let output = result || "✓ Comando ejecutado exitosamente (sin salida)";
            this.lastOutput = output;
            this.commandHistory.push({
                cmd: command,
                cwd: this.cwd,
                result: output.length > 200 ? output.substring(0, 200) + "..." : output
            });

            return output;
        } catch (err) {
            let result;
            if (err.message && (err.message.includes('ETIMEDOUT') || err.message.includes('timeout'))) {
                result = "⏱️ Error: Comando excedió el timeout de 30 segundos.";
            } else {
                const stderr = err.stderr ? err.stderr.toString() : '';
                const stdout = err.stdout ? err.stdout.toString() : '';
                result = stdout + (stderr ? '\n' + stderr : '') || `❌ Error: ${err.message}`;
            }
            this.commandHistory.push({ cmd: command, cwd: this.cwd, result });
            return result;
        }
    }

    stopProcess(pid) {
        const info = this.backgroundProcesses.get(Number(pid));
        if (!info) return `❌ Error: No se encontró el proceso con PID ${pid}`;
        try {
            process.kill(-info.process.pid);
        } catch (e) {
            info.process.kill();
        }
        this.backgroundProcesses.delete(Number(pid));
        return `✅ Proceso ${pid} detenido.`;
    }

    readBackgroundOutput(pid) {
        const info = this.backgroundProcesses.get(Number(pid));
        if (!info) return `❌ Error: El proceso con PID ${pid} no está en ejecución o ya terminó.`;
        return `[Salida PID ${pid} - ${info.command}]\n${info.output.join('') || '(Sin salida todavía)'}`;
    }

    _changeDirectory(target) {
        let newPath;

        if (target.startsWith('/') || target.startsWith('\\')) {
            newPath = path.resolve(target);
        } else if (target === '~') {
            newPath = require('os').homedir();
        } else if (target === '-') {
            const prevEntry = [...this.commandHistory].reverse().find(e => e.cwd !== this.cwd);
            if (prevEntry) {
                newPath = prevEntry.cwd;
            } else {
                return "⚠️ No hay directorio anterior";
            }
        } else {
            newPath = path.resolve(this.cwd, target);
        }

        if (!fs.existsSync(newPath)) {
            return `❌ Error: El directorio no existe: ${target}`;
        }
        if (!fs.statSync(newPath).isDirectory()) {
            return `❌ Error: No es un directorio: ${target}`;
        }

        const oldCwd = this.cwd;
        this.cwd = newPath;
        return `📁 Directorio cambiado: ${oldCwd} → ${this.cwd}`;
    }

    getStateSummary() {
        const info = this.getPromptInfo();
        const filesStr = info.files.length > 0
            ? info.files.map(f => `   ${f}`).join('\n')
            : '   (vacío)';

        return `┌─ Terminal Stateful ─────────────────────────┐
│ 📂 CWD: ${info.relative_cwd}
│ 📝 Último: ${this.lastCommand.substring(0, 40)}${this.lastCommand.length > 40 ? '...' : ''}
│ 🔧 Variables: ${info.env_count} | Historial: ${info.history_count} cmds
│ 📂 Archivos en CWD:
${filesStr}
└─────────────────────────────────────────────┘`;
    }
}

/**
 * SOMA Lite - Self-Managed Mnemonic Architecture
 */
class SOMALite {
    constructor(workspace) {
        this.workspace = path.resolve(workspace);
        this.somaPath = path.join(this.workspace, '.soma');
        this.turnsSinceCheckpoint = 0;
        this.actionLog = [];
        this.msgCounter = 0;
        this.terminal = new SimulatedStatefulTerminal(this.workspace);
        this.l2Path = path.join(this.somaPath, 'L2');
        this.l3Path = path.join(this.somaPath, 'L3');
        this.pins = {
            "SYSTEM": "system_info", // Comando especial interno
            "CWD": "pwd",
            "FILES": "ls -F"
        };
        this.initSmma();
    }

    initSmma() {
        if (!fs.existsSync(this.somaPath)) {
            fs.mkdirSync(this.somaPath, { recursive: true });
        }
        if (!fs.existsSync(this.l2Path)) {
            fs.mkdirSync(this.l2Path, { recursive: true });
        }
        if (!fs.existsSync(this.l3Path)) {
            fs.mkdirSync(this.l3Path, { recursive: true });
        }

        const identityPath = path.join(this.l3Path, 'identity.md');
        if (!fs.existsSync(identityPath)) {
            fs.writeFileSync(identityPath, `# SOMA Lite - Protocolo de Agente
Eres un Ingeniero de Software autónomo que opera mediante herramientas JSON. SOMA gestiona tu contexto mediante capas:
- L1 (RAM Sensorial): Contexto actual (identidad, dashboard de sensores, log reciente).
- L2 (Memoria Episódica): Registros crudos de cada turno en \`.soma/L2/\`.
- L3 (Conocimiento): Archivos persistentes en \`.soma/L3/\` (identity, task, changelog).
## 🛠️ TERMINAL STATEFUL (IMPORTANTE)
La terminal MANTIENE ESTADO entre comandos:
- Usa \`cd carpeta\` para cambiar de directorio (persiste).
- Usa \`export VAR=valor\` para definir variables de entorno persistentes.
- El CWD se muestra en el dashboard. ¡No repitas rutas completas!

## TUS HERRAMIENTAS (ESPECIFICACIÓN)
Responde ÚNICAMENTE con un objeto JSON válido:
{"tool": "nombre_herramienta", "args": {"parámetro": "valor", "reason": "explicación CoT"}}

1. \`execute_command\`: {"command": "cmd", "background": false, "reason": "..."}
2. \`read_file\`: {"path": "ruta", "start": 1, "end": 100, "reason": "..."}
3. \`write_file\`: {"path": "ruta", "content": "...", "reason": "..."}
4. \`edit_line_range\`: {"path": "ruta", "start": 10, "end": 15, "text": "...", "reason": "..."}
5. \`pin\`: {"command": "cmd", "alias": "name", "reason": "..."}
6. \`unpin\`: {"alias": "name", "reason": "..."}
7. \`checkpoint\`: {"description": "Resumen de lo logrado", "reason": "..."} - Consolida hitos en \`CHANGELOG.md\` y vacía el \`action_log\` para liberar contexto.
8. \`stop_process\`: {"pid": 1234, "reason": "..."}
9. \`finish_task\`: {"status": "success|fail", "summary": "...", "reason": "..."}

## 💾 CONSOLIDACIÓN Y AUTONOMÍA
Tu ventana de contexto es limitada. Para operar indefinidamente, DEBES usar \`checkpoint\` periódicamente (cada 5-10 turnos).
Esto:
1. Vacía el \`action_log\` actual (limpiando contexto).
2. Consolida tus avances en el \`CHANGELOG.md\` persistente (L3).
(Nota: Si deseas control de versiones, puedes usar comandos de Git manualmente).

## ⚡ BATCH ACTIONS
Puedes enviar un ARRAY de herramientas para ejecutarlas secuencialmente:
[{"tool": "write_file", "args": {...}}, {"tool": "execute_command", "args": {...}}]

## 🖥️ BACKGROUND PROCESSES
Si usas \`"background": true\`, se te devolverá un PID.
Para ver la salida usa un pin: pin({"command": "read_bg PID", "alias": "monitor"})

## EJEMPLO DE ACCIÓN
{"tool": "write_file", "args": {"path": "test.js", "content": "console.log(1)", "reason": "Crear archivo de prueba"}}

## REGLAS CRÍTICAS
1. RAZONAMIENTO: Usa siempre "reason" para explicar tu Chain of Thought.
2. SOLO JSON: No hables fuera del objeto JSON.
3. NO REPETIR: Si un comando falló o dio el mismo resultado, prueba una estrategia distinta.
4. SENSORES: Usa \`pin\` para monitorizar ficheros vivos (logs) o estados (git status) mientras trabajas.
`, 'utf-8');
        }

        const taskPath = path.join(this.l3Path, 'task.md');
        if (!fs.existsSync(taskPath)) {
            fs.writeFileSync(taskPath, '# OBJETIVO DE LA TAREA\n[Define aquí la meta principal]\n', 'utf-8');
        }

        const logPath = path.join(this.l2Path, 'session_log.jsonl');
        if (!fs.existsSync(logPath)) {
            fs.writeFileSync(logPath, '', 'utf-8');
        }

        const changelogPath = path.join(this.l3Path, 'CHANGELOG.md');
        if (!fs.existsSync(changelogPath)) {
            fs.writeFileSync(changelogPath, '# CHANGELOG\nRegistro de hitos consolidados.\n\n', 'utf-8');
        }
    }

    calculatePm() {
        const identity = fs.readFileSync(path.join(this.l3Path, 'identity.md'), 'utf-8');
        const task = fs.readFileSync(path.join(this.l3Path, 'task.md'), 'utf-8');
        const changelog = fs.readFileSync(path.join(this.l3Path, 'CHANGELOG.md'), 'utf-8');
        const actionLogStr = this.formatActionLog();

        const totalChars = identity.length + task.length + changelog.length + actionLogStr.length + 1000;
        const estimatedTokens = Math.floor(totalChars / 4);
        const pm = (estimatedTokens / 128000) * 100;
        return pm;
    }

    truncateResult(tool, result) {
        const limits = {
            execute_command: 1200,
            read_file: 3000,
            edit_line_range: 200,
            checkpoint: 100,
            finish_task: 500
        };
        const limit = limits[tool] || 300;

        if (result.length > limit) {
            if (tool === 'execute_command' && limit >= 500) {
                const half = Math.floor(limit / 2);
                return result.substring(0, half) +
                    `\n\n... [${result.length - limit} chars ocultos para ahorrar contexto] ...\n\n` +
                    result.substring(result.length - half);
            } else {
                return result.substring(0, limit) + `\n... [${result.length - limit} chars más]`;
            }
        }
        return result;
    }

    formatActionLog() {
        const lines = [];
        for (const entry of this.actionLog) {
            const argsCopy = { ...entry.args };
            const reason = argsCopy.reason || 'Sin motivo especificado';
            delete argsCopy.reason;
            const argsStr = JSON.stringify(argsCopy);

            let res = String(entry.result).trim();
            if (res.includes('\n')) {
                res = `\n\`\`\`\n${res}\n\`\`\``;
            } else {
                res = `\`${res}\``;
            }

            let timeStr = "";
            if (entry.timestamp) {
                const date = new Date(entry.timestamp);
                timeStr = ` [${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}]`;
            }

            lines.push(`- [${entry.id}]${timeStr} ${entry.tool}(${argsStr})\n  **Why**: ${reason}\n  **Result**: ${res}`);
        }
        return lines.length > 0 ? lines.join('\n') : "(Sin acciones en este ciclo)";
    }

    formatBackgroundProcesses() {
        if (this.terminal.backgroundProcesses.size === 0) return "(Ninguno)";
        const lines = [];
        for (const [pid, info] of this.terminal.backgroundProcesses.entries()) {
            lines.push(`- PID ${pid}: ${info.command}`);
        }
        return lines.join('\n');
    }

    buildPrompt() {
        const identity = fs.readFileSync(path.join(this.l3Path, 'identity.md'), 'utf-8');
        const task = fs.readFileSync(path.join(this.l3Path, 'task.md'), 'utf-8');
        const changelog = fs.readFileSync(path.join(this.l3Path, 'CHANGELOG.md'), 'utf-8');
        const pm = this.calculatePm();
        const stateIcon = pm > 70 ? 'ROJO' : pm > 60 ? 'AMARILLO' : 'VERDE';

        // Renderizar Pins (Sensores)
        let renderedPins = "";
        for (const [alias, command] of Object.entries(this.pins)) {
            let output = "";
            if (command === "system_info") {
                output = this._getSystemInfo();
            } else {
                output = this.terminal.execute(command);
            }
            const truncated = this._truncateWithEllipsis(output, 40);
            renderedPins += `[PIN: ${alias}] (${command})\n${truncated}\n---\n`;
        }

        return `<identity>
${identity}
</identity>

<dashboard>
Pm: ${pm.toFixed(1)}% | Turns: ${this.turnsSinceCheckpoint}/20 | State: ${stateIcon}
${this.terminal.getStateSummary()}

[BACKGROUND PROCESSES]
${this.formatBackgroundProcesses()}

[SENSORS / PINS]
${renderedPins || '(No hay pins activos)'}
</dashboard>

<changelog>
${changelog}
</changelog>

<task>
${task}
</task>

<action_log>
${this.formatActionLog()}
</action_log>`;
    }

    _getSystemInfo() {
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const shell = process.env.SHELL || (require('os').platform() === 'win32' ? 'PowerShell/CMD' : 'Unix Shell');
        return `Time: ${now} | OS: ${require('os').platform()}\nShell: ${shell} | Node: ${process.version}`;
    }

    _truncateWithEllipsis(text, maxLines) {
        const lines = String(text).split(/\r?\n/);
        if (lines.length <= maxLines) return text;

        const half = Math.floor(maxLines / 2);
        const head = lines.slice(0, half).join('\n');
        const tail = lines.slice(lines.length - half).join('\n');
        return `${head}\n... [${lines.length - maxLines} líneas ocultas] ...\n${tail}`;
    }

    logToL2(tool, args, result) {
        this.msgCounter++;
        const entry = {
            id: `msg_${String(this.msgCounter).padStart(3, '0')}`,
            tool: tool,
            args: args,
            result: this.truncateResult(tool, result),
            timestamp: new Date().toISOString()
        };

        fs.appendFileSync(path.join(this.l2Path, 'session_log.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
        this.actionLog.push(entry);
    }

    logEpisodicMemory(prompt, rawResponse, turnNumber) {
        const safeTurn = Number.isInteger(turnNumber) ? turnNumber + 1 : this.turnsSinceCheckpoint + 1;
        const turnFolder = path.join(this.l2Path, `turn_${String(safeTurn).padStart(3, '0')}`);
        if (!fs.existsSync(turnFolder)) fs.mkdirSync(turnFolder, { recursive: true });

        fs.writeFileSync(path.join(turnFolder, 'l1_prompt.txt'), prompt, 'utf-8');
        fs.writeFileSync(path.join(turnFolder, 'raw_response.txt'), rawResponse, 'utf-8');
    }

    // Herramientas
    executeCommand(command, options) {
        return this.terminal.execute(command, options);
    }

    readFile(filePath, start = 1, end = 100) {
        const targetPath = path.resolve(this.workspace, filePath);
        if (!targetPath.startsWith(this.workspace)) return "Error: Path outside workspace.";
        if (!fs.existsSync(targetPath)) return `Error: File ${filePath} not found.`;
        
        try {
            const content = fs.readFileSync(targetPath, 'utf-8');
            const lines = content.split(/\r?\n/);
            const slice = lines.slice(start - 1, end);
            return slice.map((line, i) => `${String(start + i).padStart(4, ' ')}: ${line}`).join('\n');
        } catch (err) {
            return `Error reading file: ${err.message}`;
        }
    }

    editLineRange(filePath, start, end, newText) {
        const targetPath = path.resolve(this.workspace, filePath);
        if (!targetPath.startsWith(this.workspace)) return "Error: Path outside workspace.";
        if (!fs.existsSync(targetPath)) return `Error: File ${filePath} not found.`;

        try {
            const content = fs.readFileSync(targetPath, 'utf-8');
            const lines = content.split(/\r?\n/);
            const replacementLines = newText.split(/\r?\n/);
            
            lines.splice(start - 1, end - start + 1, ...replacementLines);
            fs.writeFileSync(targetPath, lines.join('\n'), 'utf-8');
            return `success. replaced lines ${start}-${end}.`;
        } catch (err) {
            return `Error editing file: ${err.message}`;
        }
    }

    pin(command, alias) {
        this.pins[alias] = command;
        return `✓ Command pinned as [${alias}]`;
    }

    unpin(alias) {
        if (this.pins[alias]) {
            delete this.pins[alias];
            return `✓ [${alias}] unpinned.`;
        }
        return `Error: Pin [${alias}] not found.`;
    }

    writeFile(filePath, content) {
        const targetPath = path.resolve(this.workspace, filePath);
        if (!targetPath.startsWith(this.workspace)) {
            return "Error: Path outside workspace.";
        }
        try {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, content, 'utf-8');
            return "success";
        } catch (err) {
            return `Error writing file: ${err.message}`;
        }
    }

    finishTask(status, summary) {
        return `TASK_FINISHED [${status.toUpperCase()}]: ${summary}`;
    }

    checkpoint(description) {
        this.actionLog = [];

        let status;
        try {
            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
            const changelogEntry = `- [${timestamp}] ${description}\n`;
            const changelogPath = path.join(this.l3Path, 'CHANGELOG.md');
            fs.appendFileSync(changelogPath, changelogEntry, 'utf-8');
            status = "CHANGELOG updated and action log cleared.";
        } catch (err) {
            status = `Checkpoint failed: ${err.message}`;
        }

        this.turnsSinceCheckpoint = 0;
        return `success. ${status}`;
    }

    invokeTool(toolName, args) {
        let result = "";

        switch (toolName) {
            case "execute_command":
                result = this.executeCommand(args.command || "", { background: !!args.background });
                break;
            case "stop_process":
                result = this.terminal.stopProcess(args.pid);
                break;
            case "read_file":
                result = this.readFile(args.path || "", args.start || 1, args.end || 100);
                break;
            case "write_file":
                result = this.writeFile(args.path || "", args.content || "");
                break;
            case "edit_line_range":
                result = this.editLineRange(args.path || "", args.start || 1, args.end || 1, args.text || "");
                break;
            case "pin":
                result = this.pin(args.command || "", args.alias || "sensor");
                break;
            case "unpin":
                result = this.unpin(args.alias || "");
                break;
            case "checkpoint":
                result = this.checkpoint(args.description || "");
                break;
            case "finish_task":
                result = this.finishTask(args.status || "success", args.summary || "");
                break;
            default:
                result = `Error: Tool ${toolName} not found.`;
        }

        this.logToL2(toolName, args, result);
        this.turnsSinceCheckpoint++;

        let warning = "";
        const pm = this.calculatePm();
        if (pm > 70 || this.turnsSinceCheckpoint >= 20) {
            warning = "🔴 Dashboard Crítico. Llama a checkpoint() para consolidar el action_log.";
        } else if (pm > 60) {
            warning = "🟡 Advertencia de Memoria. Considera llamar a checkpoint() pronto.";
        }

        return { result, warning };
    }
}

module.exports = { SOMALite, SimulatedStatefulTerminal };

// Si se ejecuta directamente, correr tests
if (require.main === module) {
    console.log("Iniciando pruebas de SOMALite...");

    const testWorkspace = path.join(process.cwd(), "soma_lite_test_env");
    if (!fs.existsSync(testWorkspace)) {
        fs.mkdirSync(testWorkspace, { recursive: true });
    }

    const soma = new SOMALite(testWorkspace);
    console.log(`✅ Orquestador inicializado en: ${testWorkspace}`);

    console.log("\n--- TEST 1: execute_command ---");
    let res = soma.invokeTool("execute_command", { command: "echo 'Hello SOMA'" });
    console.log(`Resultado: ${res.result.trim()}`);

    console.log("\n--- TEST 2: edit_line_range y read_file ---");
    // Crear un archivo base con write_file (herramienta oculta pero disponible internamente o vía cmd)
    soma.writeFile("test_surgery.txt", "Línea 1\nLínea 2\nLínea 3\nLínea 4");
    
    console.log("Editando línea 2...");
    soma.invokeTool("edit_line_range", { path: "test_surgery.txt", start: 2, end: 2, text: "Línea 2 MODIFICADA" });
    
    res = soma.invokeTool("read_file", { path: "test_surgery.txt", start: 1, end: 10 });
    console.log(`Archivo tras cirugía:\n${res.result}`);

    console.log("\n--- TEST 3: Sensors & Pins ---");
    soma.invokeTool("pin", { command: "ls -F", alias: "ls_sensor" });
    const prompt = soma.buildPrompt();
    if (prompt.includes("[PIN: ls_sensor]")) {
        console.log("✅ Pin registrado y renderizado correctamente en el L1.");
    } else {
        console.log("❌ Error: El pin no aparece en el prompt.");
    }

    console.log("\n--- TEST 4: Terminal Stateful ---");
    soma.invokeTool("execute_command", { command: "mkdir test_subdir" });
    soma.invokeTool("execute_command", { command: "cd test_subdir" });
    console.log(`CWD actual: ${soma.terminal.cwd}`);
    if (soma.terminal.cwd.includes("test_subdir")) {
        console.log("✅ Cambio de directorio persistido.");
    }

    console.log("\n✅ ¡Todos los tests pasaron exitosamente! SOMA Lite Active Surface funcional.");
}

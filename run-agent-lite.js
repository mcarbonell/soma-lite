#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { SOMALite } = require('./soma-lite');

// Cargar variables de entorno desde .env
function loadEnvManually() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.includes('=') && !line.trim().startsWith('#')) {
                const [k, ...vParts] = line.split('=');
                const key = k.trim();
                const value = vParts.join('=').trim();
                if (key) {
                    process.env[key] = value;
                }
            }
        }
    }
}

function extractJson(text) {
    const originalText = text;
    text = text.trim();

    // Quitar bloques de código markdown
    if (text.startsWith('```')) {
        const lines = text.split('\n');
        if (lines[0].startsWith('```')) {
            lines.shift();
        }
        if (lines[lines.length - 1].startsWith('```')) {
            lines.pop();
        }
        text = lines.join('\n').trim();
    }

    // Quitar etiquetas XML/thinking
    text = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
    text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
    text = text.replace(/<invoke>[\s\S]*?<\/invoke>/g, '');
    text = text.replace(/<function=[^>]*>[\s\S]*?<\/function>/g, '');
    text = text.replace(/<parameter=[^>]*>[\s\S]*?<\/parameter>/g, '');
    text = text.trim();

    try {
        // Buscar el primer '{' o '['
        let firstBrace = text.indexOf('{');
        let firstBracket = text.indexOf('[');

        let start = -1;
        let openChar, closeChar;

        if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
            start = firstBrace;
            openChar = '{';
            closeChar = '}';
        } else if (firstBracket !== -1) {
            start = firstBracket;
            openChar = '[';
            closeChar = ']';
        }

        if (start === -1) return null;

        let count = 0;
        let end = -1;
        for (let i = start; i < text.length; i++) {
            if (text[i] === openChar) count++;
            else if (text[i] === closeChar) {
                count--;
                if (count === 0) {
                    end = i;
                    break;
                }
            }
        }

        if (end === -1) return null;

        const jsonStr = text.substring(start, end + 1);
        return JSON.parse(jsonStr);
    } catch (e) {
        return null;
    }
}

function estimateTokens(text) {
    return Math.floor(text.length / 4);
}

function truncatePrompt(prompt, maxTokens) {
    const estimatedTokens = estimateTokens(prompt);
    if (estimatedTokens <= maxTokens) {
        return prompt;
    }

    const maxChars = maxTokens * 4;
    return prompt.substring(0, maxChars) +
        `\n\n[... CONTENIDO TRUNCADO: ${prompt.length - maxChars} caracteres omitidos para ajustarse al contexto ...]`;
}

async function callOpenRouter(apiKey, model, messages, maxTokens) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/soma-agent',
            'X-Title': 'SOMA Lite Agent'
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.0,
            max_tokens: maxTokens
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    return await response.json();
}

async function callGoogle(apiKey, model, messages, maxTokens) {
    // Convertir formato OpenAI a formato Gemini
    const contents = [];
    for (const msg of messages) {
        contents.push({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: contents,
            generationConfig: {
                temperature: 0.0,
                maxOutputTokens: maxTokens
            }
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    // Convertir formato Gemini a formato OpenAI
    return {
        choices: [{
            message: {
                content: data.candidates?.[0]?.content?.parts?.[0]?.text || ''
            }
        }]
    };
}

async function callAnthropic(apiKey, model, messages, maxTokens) {
    // Separar system de mensajes
    let system = "";
    const conversation = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            system = msg.content;
        } else {
            conversation.push({
                role: msg.role,
                content: msg.content
            });
        }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: model,
            max_tokens: maxTokens,
            temperature: 0.0,
            system: system,
            messages: conversation
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return {
        choices: [{
            message: {
                content: data.content?.[0]?.text || ''
            }
        }]
    };
}

async function callOpenAI(apiKey, model, messages, maxTokens) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.0,
            max_tokens: maxTokens
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    return await response.json();
}

async function callInference(provider, apiKey, model, messages, maxTokens) {
    switch (provider) {
        case 'openrouter':
            return callOpenRouter(apiKey, model, messages, maxTokens);
        case 'google':
            return callGoogle(apiKey, model, messages, maxTokens);
        case 'anthropic':
            return callAnthropic(apiKey, model, messages, maxTokens);
        case 'openai':
            return callOpenAI(apiKey, model, messages, maxTokens);
        default:
            throw new Error(`Proveedor no soportado: ${provider}`);
    }
}

function getApiKey(provider) {
    const keyMap = {
        'openrouter': 'OPENROUTER_API_KEY',
        'google': 'GOOGLE_API_KEY',
        'anthropic': 'ANTHROPIC_API_KEY',
        'openai': 'OPENAI_API_KEY'
    };
    const envKey = keyMap[provider];
    if (!envKey) return null;
    return process.env[envKey] || null;
}

function getContextWindow(model, provider) {
    // Context windows comunes por proveedor/modelo
    const defaults = {
        'openrouter': 128000,
        'google': 1000000,  // Gemini tiene 1M contexto
        'anthropic': 200000, // Claude 3
        'openai': 128000
    };
    return defaults[provider] || 128000;
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runAgent() {
    loadEnvManually();

    // Parsear argumentos manualmente (sin dependencias externas)
    const args = {
        task: null,
        maxTurns: 5,
        model: 'gemini-flash-lite-latest',
        provider: 'google',
        workspace: 'agent_workspace_test_2',
        debug: false,
        rpm: 5,
        contextWindow: null,
        maxTokens: 4096
    };

    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        const nextArg = process.argv[i + 1];

        switch (arg) {
            case '--task':
                args.task = nextArg;
                i++;
                break;
            case '--max-turns':
                args.maxTurns = parseInt(nextArg);
                i++;
                break;
            case '--model':
                args.model = nextArg;
                i++;
                break;
            case '--provider':
                args.provider = nextArg;
                i++;
                break;
            case '--workspace':
                args.workspace = nextArg;
                i++;
                break;
            case '--debug':
                args.debug = true;
                break;
            case '--rpm':
                args.rpm = parseInt(nextArg);
                i++;
                break;
            case '--context-window':
                args.contextWindow = parseInt(nextArg);
                i++;
                break;
            case '--max-tokens':
                args.maxTokens = parseInt(nextArg);
                i++;
                break;
        }
    }

    const turnDelay = args.rpm > 0 ? (60.0 / args.rpm) * 1000 : 1000;

    // Verificar API key
    const apiKey = getApiKey(args.provider);
    if (!apiKey) {
        console.error(`❌ ERROR: API Key para ${args.provider} no encontrada.`);
        console.error(`   Define ${args.provider.toUpperCase()}_API_KEY en tu archivo .env`);
        process.exit(1);
    }

    const contextWindow = args.contextWindow || getContextWindow(args.model, args.provider);
    console.log(`📏 Context window: ${contextWindow.toLocaleString()} tokens`);

    const workspacePath = path.resolve(args.workspace);
    console.log(`🚀 Iniciando SOMA Lite Agent Loop en: ${workspacePath}`);
    console.log(`🤖 Proveedor: ${args.provider} | Modelo: ${args.model} | Turnos: ${args.maxTurns}`);

    const soma = new SOMALite(workspacePath);

    // Configurar la tarea
    const taskFile = path.join(soma.l3Path, 'task.md');
    if (args.task) {
        const taskContent = `# OBJETIVO DE LA TAREA\n${args.task}\n`;
        fs.writeFileSync(taskFile, taskContent, 'utf-8');
    } else {
        if (!fs.existsSync(taskFile)) {
            const taskContent = `# OBJETIVO DE LA TAREA\nCrea un script 'hola.js' que imprima la fecha actual y ejecútalo.\n`;
            fs.writeFileSync(taskFile, taskContent, 'utf-8');
        }
    }
    const sysInstr = "You are SOMA Lite, an autonomous software engineer. Follow the protocol and rules defined in your <identity> context.";

    const availableContext = contextWindow - args.maxTokens - estimateTokens(sysInstr);
    console.log(`📏 Espacio disponible para L1: ${availableContext.toLocaleString()} tokens`);

    // Preparar directorio de debug
    const debugDir = path.join(soma.l2Path, 'debug');
    if (args.debug) {
        if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true });
        }
        // Limpiar archivos debug anteriores
        for (const f of fs.readdirSync(debugDir)) {
            if (f.startsWith('L1_')) {
                fs.unlinkSync(path.join(debugDir, f));
            }
        }
    }

    for (let i = 0; i < args.maxTurns; i++) {
        const prompt = soma.buildPrompt();
        const pm = soma.calculatePm();

        if (args.debug) {
            const debugFile = path.join(debugDir, `L1_${i}.txt`);
            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
            const debugContent = `=== SOMA Lite Debug - Turno ${i} ===
Timestamp: ${timestamp}
Pm: ${pm.toFixed(2)}%
Turns since checkpoint: ${soma.turnsSinceCheckpoint}
CWD (Terminal): ${soma.terminal.cwd}

=== CONTENIDO L1 (Lo que ve el agente) ===

${prompt}

=== FIN L1 ===
`;
            fs.writeFileSync(debugFile, debugContent, 'utf-8');
            console.log(`\n💾 Debug: L1 guardado en ${debugFile}`);
            console.log('\n🔍 DEBUG: CONTENIDO MEMORIA L1 🔍');
            console.log('-'.repeat(50));
            console.log(prompt);
            console.log('-'.repeat(50));
            console.log(`📊 Pm Calculado: ${pm.toFixed(2)}%`);
            console.log('-'.repeat(50) + '\n');
        }

        console.log(`\n${'='.repeat(40)}`);
        console.log(`🔄 Turno ${i + 1}/${args.maxTurns} - Pensando (${args.provider})...`);

        let agentReply = "";
        let finalPrompt = prompt;
        try {
            const promptTokens = estimateTokens(prompt);

            if (promptTokens > availableContext) {
                console.log(`⚠️ Prompt excede el contexto (${promptTokens} > ${availableContext} tokens). Truncando...`);
                finalPrompt = truncatePrompt(prompt, availableContext);
                console.log(`📏 Prompt truncado a ${estimateTokens(finalPrompt)} tokens`);
            }

            const messages = [
                { role: 'system', content: sysInstr },
                { role: 'user', content: finalPrompt }
            ];

            const response = await callInference(args.provider, apiKey, args.model, messages, args.maxTokens);
            agentReply = response.choices[0].message.content;

            console.log(`🤖 Respuesta:\n${agentReply}`);

            // Guardar Memoria Episódica L2 (Prompt + Respuesta Cruda)
            soma.logEpisodicMemory(finalPrompt, agentReply);
        } catch (err) {
            console.error(`❌ Error de API: ${err.message}`);
            if (args.debug) {
                console.error(err.stack);
            }
            break;
        }

        if (args.debug) {
            const rawFile = path.join(debugDir, `RAW_turn_${i}.txt`);
            fs.writeFileSync(rawFile, `=== Turno ${i} - RESPUESTA RAW DEL MODELO ===\n\n${agentReply}\n\n=== FIN ===`, 'utf-8');
        }

        const action = extractJson(agentReply);
        if (!action) {
            console.log("❌ Error de parseo JSON. Reintentando...");
            if (args.debug) {
                const errorFile = path.join(debugDir, `JSON_ERROR_turn_${i}.txt`);
                fs.writeFileSync(errorFile, `=== Turno ${i} - JSON Parse Error ===\n\nRespuesta del agente:\n${agentReply}\n\n=== FIN ===`, 'utf-8');
                console.log(`💾 Respuesta malformada guardada en: ${errorFile}`);
            }
            soma.logToL2("JSON_ERROR", { raw_response: agentReply.substring(0, 200) }, "Error: Envía solo JSON válido.");
            continue;
        }

        const actions = Array.isArray(action) ? action : [action];
        let taskFinished = false;

        for (const act of actions) {
            const tool = act.tool;
            const argsTool = act.args || {};

            console.log(`🛠️  Ejecutando: ${tool}`);
            const { result, warning } = soma.invokeTool(tool, argsTool);

            console.log(`📄 Resultado (trunc): ${String(result).substring(0, 150)}...`);
            if (warning) {
                console.log(`⚠️ ${warning}`);
            }

            if (tool === "finish_task") {
                const status = (argsTool.status || 'N/A').toUpperCase();
                console.log(`\n✅ ¡TAREA FINALIZADA POR EL AGENTE! [STATUS: ${status}]`);
                console.log(`Resumen: ${argsTool.summary}`);
                taskFinished = true;
                break;
            }
        }

        if (taskFinished) break;

        if (i < args.maxTurns - 1) {
            console.log(`⏳ Esperando ${(turnDelay / 1000).toFixed(1)}s para respetar límite de ${args.rpm} RPM...`);
            await sleep(turnDelay);
        }
    }
}

// Mostrar ayuda si se solicita
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
SOMA Lite Agent Runner (Node.js)

Uso: node run-agent-lite.js [opciones]

Opciones:
  --task "descripción"      Tarea a realizar por el agente
  --max-turns N             Máximo de turnos (default: 5)
  --model "modelo"          Modelo a usar (default: stepfun/step-3.5-flash:free)
  --provider PROV           Proveedor: openrouter|google|anthropic|openai (default: openrouter)
  --workspace DIR           Directorio de trabajo (default: agent_workspace_test_2)
  --debug                   Muestra contenido de memoria L1 y Pm en cada turno
  --rpm N                   Máximo de peticiones por minuto (default: 5)
  --context-window N        Override del tamaño de contexto
  --max-tokens N            Máximo de tokens de salida (default: 4096)
  --help, -h                Muestra esta ayuda

Ejemplos:
  node run-agent-lite.js --task "Crea un script hola.js" --max-turns 5
  node run-agent-lite.js --provider google --model gemini-3.1-flash-lite-preview --task "Analiza archivos"
  node run-agent-lite.js --provider anthropic --model claude-3-5-haiku-20241022 --task "Refactoriza código"
`);
    process.exit(0);
}

// Ejecutar
runAgent().catch(err => {
    console.error('Error fatal:', err);
    process.exit(1);
});
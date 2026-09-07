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

function extractGemmaToolCalls(text) {
    const calls = [];
    const regex = /<\|tool_call\>call:([a-zA-Z_][\w-]*)\{([\s\S]*?)\}<tool_call\|>/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const tool = match[1];
        const rawArgs = match[2].trim();
        const args = {};

        const argRegex = /(\w+):(?:<\|""\|>([\s\S]*?)<\|""\|>|<\|"|"\|>([\s\S]*?)<\|"|"\|>|([^,}]*))/g;
        let argMatch;
        while ((argMatch = argRegex.exec(rawArgs)) !== null) {
            const key = argMatch[1];
            const value = (argMatch[2] || argMatch[3] || argMatch[4] || "").trim();
            if (value === "true") args[key] = true;
            else if (value === "false") args[key] = false;
            else if (value !== "" && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) args[key] = Number(value);
            else args[key] = value;
        }

        calls.push({ tool, args });
    }

    return calls.length ? calls : null;
}

function getToolStrategy(provider, model) {
    const normalized = `${provider || ""}:${model || ""}`.toLowerCase();
    const isGemma = normalized.includes("google:") && normalized.includes("gemma");

    if (isGemma) {
        return {
            name: "gemma-tools",
            systemPrompt: `You are SOMA Lite running on Gemma 4.

Use the available tools directly. Do not write plans or explanations.
Return exactly one tool call in the Gemma tool-call format:
<|tool_call>call:tool_name{arg1:...}<tool_call|>

If you need multiple steps, return one tool call at a time.`,
            parseReply(text) {
                return extractGemmaToolCalls(text) || extractJson(text);
            }
        };
    }

    return {
        name: "json-tools",
        systemPrompt: `You are SOMA Lite.
Return exactly one valid JSON object or a JSON array of tool calls.
Do not include prose, markdown, or explanations outside the JSON.`,
        parseReply(text) {
            return extractJson(text);
        }
    };
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

function buildGoogleFunctionDeclarations() {
    return [
        {
            name: 'execute_command',
            description: 'Execute a shell command in the persistent terminal.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Command to execute.' },
                    background: { type: 'boolean', description: 'Run in background if true.' }
                },
                required: ['command']
            }
        },
        {
            name: 'read_file',
            description: 'Read a file from the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative file path.' },
                    start: { type: 'integer', description: 'Starting line number.' },
                    end: { type: 'integer', description: 'Ending line number.' }
                },
                required: ['path']
            }
        },
        {
            name: 'write_file',
            description: 'Write content to a file inside the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative file path.' },
                    content: { type: 'string', description: 'File content.' }
                },
                required: ['path', 'content']
            }
        },
        {
            name: 'checkpoint',
            description: 'Consolidate progress and clear the action log.',
            parameters: {
                type: 'object',
                properties: {
                    description: { type: 'string', description: 'Checkpoint summary.' }
                },
                required: ['description']
            }
        },
        {
            name: 'finish_task',
            description: 'Mark the task as finished.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', description: 'success or fail.' },
                    summary: { type: 'string', description: 'Short summary.' },
                    feedback: { type: 'string', description: 'Optional feedback.' }
                },
                required: ['status', 'summary']
            }
        },
        {
            name: 'add_note',
            description: 'Add a structured note to persistent memory.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Note title.' },
                    content: { type: 'string', description: 'Note content.' }
                },
                required: ['title', 'content']
            }
        },
        {
            name: 'update_note',
            description: 'Update an existing note.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Note ID.' },
                    title: { type: 'string', description: 'Optional new title.' },
                    content: { type: 'string', description: 'Optional new content.' }
                },
                required: ['id']
            }
        },
        {
            name: 'delete_note',
            description: 'Delete an existing note.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Note ID.' }
                },
                required: ['id']
            }
        },
        {
            name: 'collapse_note',
            description: 'Collapse or expand a note.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Note ID.' },
                    collapsed: { type: 'boolean', description: 'Whether the note is collapsed.' }
                },
                required: ['id']
            }
        }
    ];
}

async function callGoogle(apiKey, model, messages, maxTokens) {
    // Convertir formato OpenAI a formato Gemini
    const contents = [];
    let systemInstruction = "";
    for (const msg of messages) {
        if (msg.role === 'system') {
            systemInstruction = msg.content;
            continue;
        }
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
            systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
            tools: [{
                functionDeclarations: buildGoogleFunctionDeclarations()
            }],
            toolConfig: {
                functionCallingConfig: {
                    mode: 'ANY'
                }
            },
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
    const functionCalls = [];
    for (const candidate of data.candidates || []) {
        for (const part of candidate.content?.parts || []) {
            if (part.functionCall) {
                functionCalls.push(part.functionCall);
            }
        }
    }
    // Convertir formato Gemini a formato OpenAI
    return {
        raw: data,
        choices: [{
            message: {
                content: data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
            }
        }],
        functionCalls
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

function cleanWorkspace(workspacePath) {
    const resolved = path.resolve(workspacePath);
    if (fs.existsSync(resolved)) {
        fs.rmSync(resolved, { recursive: true, force: true });
    }
    fs.mkdirSync(resolved, { recursive: true });
}

function writeDebugArtifact(debugDir, turnIndex, kind, payload) {
    if (!debugDir) return;
    const filePath = path.join(debugDir, `${kind}_turn_${turnIndex}.json`);
    const content = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    fs.writeFileSync(filePath, content, 'utf-8');
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
    cleanWorkspace(workspacePath);
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
    const toolStrategy = getToolStrategy(args.provider, args.model);
    const sysInstr = toolStrategy.systemPrompt;

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

        let rawReply = "";
        let parsedReply = "";
        let finalPrompt = prompt;
        let googleConversation = null;
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

            if (args.debug) {
                writeDebugArtifact(debugDir, i, 'REQUEST', {
                    provider: args.provider,
                    model: args.model,
                    max_tokens: args.maxTokens,
                    temperature: 0.0,
                    messages
                });
            }

            const response = await callInference(args.provider, apiKey, args.model, messages, args.maxTokens);
            if (args.debug) {
                writeDebugArtifact(debugDir, i, 'API_RESPONSE', response?.raw || response);
            }
            rawReply = response.choices[0].message.content || "";
            parsedReply = rawReply;

            console.log(`🤖 Respuesta:\n${rawReply}`);

            // Guardar Memoria Episódica L2 (Prompt + Respuesta Cruda)
            soma.logEpisodicMemory(finalPrompt, rawReply, i);

            if (args.provider === 'google' && response.functionCalls && response.functionCalls.length > 0) {
                googleConversation = [
                    { role: 'system', content: sysInstr },
                    { role: 'user', content: finalPrompt }
                ];

                for (const fnCall of response.functionCalls) {
                    const toolName = fnCall.name || fnCall.function?.name;
                    const toolArgs = fnCall.args || fnCall.function?.arguments || {};
                    if (!toolName) continue;

                    console.log(`🛠️  Ejecutando: ${toolName}`);
                    const { result, warning } = soma.invokeTool(toolName, toolArgs);
                    console.log(`📄 Resultado (trunc): ${String(result).substring(0, 150)}...`);
                    if (warning) {
                        console.log(`⚠️ ${warning}`);
                    }

                    googleConversation.push({
                        role: 'model',
                        parts: [{ functionCall: { name: toolName, args: toolArgs } }]
                    });
                    googleConversation.push({
                        role: 'user',
                        parts: [{
                            functionResponse: {
                                name: toolName,
                                response: { result: String(result) }
                            }
                        }]
                    });
                }

                const followUp = await callInference(args.provider, apiKey, args.model, googleConversation.map(msg => {
                    if (msg.role === 'system') return { role: 'system', content: msg.content };
                    if (msg.role === 'user' && msg.content) return { role: 'user', content: msg.content };
                    if (msg.role === 'model' && msg.parts?.[0]?.functionCall) {
                        return { role: 'model', content: JSON.stringify({ functionCall: msg.parts[0].functionCall }) };
                    }
                    if (msg.role === 'user' && msg.parts?.[0]?.functionResponse) {
                        return { role: 'user', content: JSON.stringify({ functionResponse: msg.parts[0].functionResponse }) };
                    }
                    return msg;
                }), args.maxTokens);

                rawReply = followUp.choices[0].message.content || "";
                parsedReply = rawReply;
                console.log(`🤖 Respuesta final:\n${rawReply}`);
                if (args.debug) {
                    writeDebugArtifact(debugDir, i, 'FINAL_RESPONSE', rawReply);
                }
            }
        } catch (err) {
            console.error(`❌ Error de API: ${err.message}`);
            if (args.debug) {
                console.error(err.stack);
            }
            break;
        }

        if (args.debug) {
            const rawFile = path.join(debugDir, `RAW_turn_${i}.txt`);
            fs.writeFileSync(rawFile, `=== Turno ${i} - RESPUESTA RAW DEL MODELO ===\n\n${rawReply}\n\n=== FIN ===`, 'utf-8');
        }

        let action = toolStrategy.parseReply(parsedReply);
        if (!action) {
            if (args.provider === 'google') {
                console.log("❌ Google no devolvió una llamada de herramienta parseable.");
                if (args.debug) {
                    const errorFile = path.join(debugDir, `JSON_ERROR_turn_${i}.txt`);
                    fs.writeFileSync(errorFile, `=== Turno ${i} - Google Function Call Parse Error ===\n\nRespuesta del agente:\n${rawReply}\n\n=== FIN ===`, 'utf-8');
                    console.log(`💾 Respuesta malformada guardada en: ${errorFile}`);
                }
                soma.logToL2("JSON_ERROR", { raw_response: rawReply.substring(0, 200) }, "Error: Google no devolvió functionCall.");
                continue;
            }

            console.log("❌ Error de parseo JSON. Reintentando con instrucción reforzada...");
            try {
                const repairMessages = [
                    { role: 'system', content: sysInstr },
                    { role: 'user', content: `${finalPrompt}\n\nIMPORTANT: Your previous answer was invalid. Reply only in the required tool-call format. No prose.` }
                ];
                if (args.debug) {
                    writeDebugArtifact(debugDir, i, 'REPAIR_REQUEST', {
                        provider: args.provider,
                        model: args.model,
                        max_tokens: args.maxTokens,
                        temperature: 0.0,
                        messages: repairMessages
                    });
                }
                const repairResponse = await callInference(args.provider, apiKey, args.model, repairMessages, args.maxTokens);
                const repairReply = repairResponse.choices[0].message.content;
                console.log(`🤖 Respuesta de reparación:\n${repairReply}`);
                if (args.debug) {
                    writeDebugArtifact(debugDir, i, 'REPAIR_RESPONSE', repairReply);
                }
                action = toolStrategy.parseReply(repairReply);
            } catch (repairErr) {
                console.log(`❌ La reparación también falló: ${repairErr.message}`);
            }

            if (!action) {
                console.log("❌ Error de parseo JSON. Reintentando...");
                if (args.debug) {
                    const errorFile = path.join(debugDir, `JSON_ERROR_turn_${i}.txt`);
                    fs.writeFileSync(errorFile, `=== Turno ${i} - JSON Parse Error ===\n\nRespuesta del agente:\n${rawReply}\n\n=== FIN ===`, 'utf-8');
                    console.log(`💾 Respuesta malformada guardada en: ${errorFile}`);
                }
                soma.logToL2("JSON_ERROR", { raw_response: rawReply.substring(0, 200) }, "Error: Envía solo JSON válido.");
                continue;
            }
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

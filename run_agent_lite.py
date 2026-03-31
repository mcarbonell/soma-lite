import os
import json
import time
import argparse
import sys
from pathlib import Path
from datetime import datetime

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.append(str(PROJECT_ROOT))

# Cargar env manualmente para no depender de python-dotenv
def load_env_manually():
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                if "=" in line and not line.strip().startswith("#"):
                    k, v = line.strip().split("=", 1)
                    os.environ[k.strip()] = v.strip()

# Forzar salida en UTF-8
if sys.stdout.encoding != 'utf-8':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Importar el sistema unificado de proveedores
try:
    from task_runner.inference_provider import (
        resolve_provider_config,
        create_inference_client,
        get_effective_max_tokens
    )
except ImportError:
    print("❌ Error: No se pudo importar inference_provider. Asegúrate de que task_runner/ existe.")
    sys.exit(1)

# Asegurarse de importar SOMALite desde el script local
from soma_lite import SOMALite

def extract_json(text: str) -> dict:
    """Extrae JSON de un string que puede contener markdown, XML o texto extra."""
    import re
    
    original_text = text
    text = text.strip()
    
    # Quitar bloques de código markdown
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    
    # Quitar etiquetas XML/thinking comunes de modelos
    text = re.sub(r'<thinking>.*?</thinking>', '', text, flags=re.DOTALL)
    text = re.sub(r'<tool_call>.*?</tool_call>', '', text, flags=re.DOTALL)
    text = re.sub(r'<invoke>.*?</invoke>', '', text, flags=re.DOTALL)
    text = re.sub(r'<function=.*?>.*?</function>', '', text, flags=re.DOTALL)
    text = re.sub(r'<parameter=.*?>.*?</parameter>', '', text, flags=re.DOTALL)
    text = text.strip()
    
    # Si queda texto suelto antes o después del JSON, intentar extraer solo el JSON
    # Buscar el primer '{' y el último '}' balanceados
    try:
        start = text.find('{')
        if start == -1:
            return None
        
        # Encontrar el '}' correspondiente balanceado
        count = 0
        end = start
        for i, char in enumerate(text[start:], start):
            if char == '{':
                count += 1
            elif char == '}':
                count -= 1
                if count == 0:
                    end = i
                    break
        
        if count != 0:
            # No está balanceado, intentar buscar cualquier objeto JSON
            match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
            if match:
                json_str = match.group(0)
                return json.loads(json_str)
            return None
        
        json_str = text[start:end+1]
        return json.loads(json_str)
    except Exception as e:
        # Guardar el error para debug
        debug_info = f"JSON Parse Error: {e}\nOriginal: {original_text[:200]}..."
        return None

def estimate_tokens(text: str) -> int:
    """Estima el número de tokens de un texto (aproximación: 1 token ≈ 4 caracteres)."""
    return len(text) // 4


def truncate_prompt(prompt: str, max_tokens: int) -> str:
    """
    Trunca el prompt para que quepa en el contexto.
    Mantiene el inicio (instrucciones) y trunca desde el final.
    """
    estimated_tokens = estimate_tokens(prompt)
    if estimated_tokens <= max_tokens:
        return prompt
    
    # Calcular cuántos caracteres podemos mantener
    max_chars = max_tokens * 4
    
    # Mantener el inicio y añadir indicador de truncado
    truncated = prompt[:max_chars]
    truncated += f"\n\n[... CONTENIDO TRUNCADO: {len(prompt) - max_chars} caracteres omitidos para ajustarse al contexto ...]"
    
    return truncated


def run_agent():
    load_env_manually()
    
    parser = argparse.ArgumentParser(
        description="SOMA Lite Agent Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Ejemplos de uso:
  # Tarea simple con OpenRouter (default)
  python run_agent_lite.py --task "Crea un script hola.py" --max-turns 5
  
  # Usando Google Gemini
  python run_agent_lite.py --provider google --model gemini-2.5-flash-lite --task "Analiza archivos"
  
  # Usando Anthropic Claude
  python run_agent_lite.py --provider anthropic --model claude-3-5-haiku-20241022 --task "Refactoriza código"
  
  # Con debug y control de rate limiting
  python run_agent_lite.py --task "Crea tests" --debug --rpm 30 --max-turns 10
  
Proveedores soportados: zen, google, openai, anthropic, openrouter, groq, lmstudio
        """
    )
    parser.add_argument("--task", type=str, help="Tarea a realizar por el agente")
    parser.add_argument("--max-turns", type=int, default=5, help="Máximo de turnos permitidos")
    parser.add_argument("--model", type=str, default="stepfun/step-3.5-flash:free", help="Modelo a usar")
    parser.add_argument("--provider", type=str, 
                       choices=["zen", "google", "openai", "anthropic", "openrouter", "groq", "lmstudio"], 
                       default="openrouter", 
                       help="Proveedor de IA")
    parser.add_argument("--workspace", type=str, default="agent_workspace_test_2", help="Directorio de trabajo")
    parser.add_argument("--debug", action="store_true", help="Muestra el contenido de la memoria L1 y Pm en cada turno")
    parser.add_argument("--rpm", type=int, default=5, help="Máximo de peticiones (turnos) por minuto para evitar rate limits")
    parser.add_argument("--context-window", type=int, help="Override del tamaño de contexto del modelo (tokens). Si no se especifica, se intenta obtener de la API")
    parser.add_argument("--max-tokens", type=int, default=4096, help="Máximo de tokens de salida por respuesta (default: 4096)")
    
    args = parser.parse_args()

    # Calcular retardo entre turnos basado en RPM
    turn_delay = 60.0 / args.rpm if args.rpm > 0 else 1.0

    # Resolver configuración del proveedor usando el sistema unificado
    try:
        config = resolve_provider_config(provider=args.provider)
        if not config.api_key:
            print(f"❌ ERROR: API Key para {args.provider} no encontrada en el entorno.")
            print(f"   Define la variable de entorno correspondiente en tu archivo .env")
            return
    except Exception as e:
        print(f"❌ ERROR al configurar proveedor: {e}")
        return

    # Obtener el context window efectivo del modelo
    try:
        context_window = get_effective_max_tokens(
            config,
            args.model,
            user_override=args.context_window
        )
        print(f"📏 Context window: {context_window:,} tokens")
    except Exception as e:
        print(f"⚠️ No se pudo obtener context window: {e}")
        context_window = args.context_window or 128000
        print(f"📏 Usando valor por defecto: {context_window:,} tokens")
    
    # Preparar el workspace
    workspace_path = Path(args.workspace).resolve()
    print(f"🚀 Iniciando SOMA Lite Agent Loop en: {workspace_path}")
    print(f"🤖 Proveedor: {args.provider} | Modelo: {args.model} | Turnos: {args.max_turns}")
    
    soma = SOMALite(workspace_path)
    
    # Configurar la tarea
    task_file = workspace_path / ".soma" / "task.md"
    if args.task:
        task_content = f"# OBJETIVO DE LA TAREA\n{args.task}\n"
        task_file.write_text(task_content, encoding="utf-8")
    else:
        # Default task if file is empty or missing
        if not task_file.exists() or "[Define aquí la meta principal]" in task_file.read_text():
            task_content = "# OBJETIVO DE LA TAREA\nCrea un script 'hola.py' que imprima la fecha actual y ejecútalo.\n"
            task_file.write_text(task_content, encoding="utf-8")

    # Calcular tokens disponibles para el prompt (dejar margen para respuesta)
    sys_instr = f"""# SOMA Lite - Protocolo de Agente
Eres un Ingeniero de Software que opera mediante herramientas JSON.

## FORMATO DE RESPUESTA
Responde ÚNICAMENTE con un objeto JSON válido con este esquema:
{{"tool": "nombre_herramienta", "args": {{"parámetro": "valor", "reason": "explicación CoT"}}}}

## 🖥️ TERMINAL STATEFUL (IMPORTANTE)
La terminal MANTIENE ESTADO entre comandos:
- Usa `cd carpeta` para cambiar de directorio (persiste entre comandos)
- Usa `export VAR=valor` para definir variables de entorno persistentes
- Usa `unset VAR` para eliminar variables
- El CWD actual se muestra en el dashboard - ¡no repitas rutas completas!

## TUS HERRAMIENTAS (ESPECIFICACIÓN)
Todas las herramientas requieren el campo "reason" detallando tu razonamiento (opcional en notas).
1. `execute_command`: {{"command": "cmd", "reason": "..."}} - Stateful: recuerda cd e exports
2. `read_file`: {{"path": "ruta", "reason": "..."}}
3. `write_file`: {{"path": "ruta", "content": "...", "reason": "..."}}
4. `add_note`: {{"title": "título", "content": "..."}} - Crea una nota (n1, n2...)
5. `update_note`: {{"id": "n1", "title": "opcional", "content": "opcional"}}
6. `delete_note`: {{"id": "n1"}}
7. `collapse_note`: {{"id": "n1", "collapsed": true|false}} - Oculta/Muestra contenido
8. `checkpoint`: {{"description": "...", "reason": "..."}}
9. `finish_task`: {{"status": "success|fail", "summary": "...", "reason": "...", "feedback": "..."}}

## REGLAS CRÍTICAS
1. RAZONAMIENTO OBLIGATORIO: Usa siempre "reason" para explicar qué esperas de la acción.
2. NO HABLAR: No saludes, no expliques fuera del JSON. SOLO responde JSON.
3. NO REPETIR: Si ves en <action_log> un comando idéntico, NO lo repitas.
4. ENTORNO NO INTERACTIVO: No uses comandos que requieran entrada del usuario (ej: `input()`). 
5. APROVECHA EL ESTADO: Usa `cd` y `export` para evitar repetir rutas/valores en cada comando.
6. ARGUMENTOS CLI: Diseña tus scripts para recibir datos mediante `sys.argv`.
4. VERIFICACIÓN: Siempre que escribas código, pruébalo con `execute_command`.

## EJEMPLOS DE ACCIÓN
- Turno 1: {{"tool": "execute_command", "args": {{"command": "ls", "reason": "Explorar archivos existentes"}}}}
- Turno 2: {{"tool": "write_file", "args": {{"path": "f.py", "content": "print(1)", "reason": "Crear script base"}}}}
- Turno 3: {{"tool": "finish_task", "args": {{"status": "success", "summary": "Hecho", "reason": "Objetivo cumplido"}}}}
"""

    available_context = context_window - args.max_tokens - estimate_tokens(sys_instr)

    # Preparar directorio de debug si está activado
    debug_dir = workspace_path / ".soma" / "debug"
    if args.debug:
        debug_dir.mkdir(parents=True, exist_ok=True)
        # Limpiar archivos debug anteriores
        for f in debug_dir.glob("L1_*.txt"):
            f.unlink()
    
    for i in range(args.max_turns):
        prompt = soma.build_prompt()
        pm = soma.calculate_pm()

        if args.debug:
            # Guardar L1 en archivo para depuración
            debug_file = debug_dir / f"L1_{i}.txt"
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            debug_content = f"""=== SOMA Lite Debug - Turno {i} ===
Timestamp: {timestamp}
Pm: {pm:.2f}%
Turns since checkpoint: {soma.turns_since_checkpoint}
CWD (Terminal): {soma.terminal.cwd}

=== CONTENIDO L1 (Lo que ve el agente) ===

{prompt}

=== FIN L1 ===
"""
            try:
                debug_file.write_text(debug_content, encoding="utf-8")
                print(f"\n💾 Debug: L1 guardado en {debug_file}")
            except Exception as e:
                print(f"\n⚠️ Error guardando debug: {e}")
            
            print("\n" + "🔍" + " DEBUG: CONTENIDO MEMORIA L1 " + "🔍")
            print("-" * 50)
            try:
                # Usar print con codificación segura
                print(prompt.encode(sys.stdout.encoding, errors='replace').decode(sys.stdout.encoding))
            except Exception:
                print("[ERROR DE CODIFICACIÓN AL MOSTRAR PROMPT]")
            print("-" * 50)
            print(f"📊 Pm Calculado: {pm:.2f}%")
            print("-" * 50 + "\n")

        print(f"\n" + "="*40)
        print(f"🔄 Turno {i+1}/{args.max_turns} - Pensando ({args.provider})...")
        
        agent_reply = ""
        try:
            # Crear cliente unificado
            client = create_inference_client(config)
            
            # Truncar prompt si excede el espacio disponible
            prompt_tokens = estimate_tokens(prompt)
            if prompt_tokens > available_context:
                print(f"⚠️ Prompt excede el contexto ({prompt_tokens} > {available_context} tokens). Truncando...")
                prompt = truncate_prompt(prompt, available_context)
                prompt_tokens = estimate_tokens(prompt)
                print(f"📏 Prompt truncado a {prompt_tokens} tokens")
            
            # Preparar mensajes
            messages = [
                {"role": "system", "content": sys_instr},
                {"role": "user", "content": prompt}
            ]
            
            # Llamar a la API usando el cliente unificado
            api_params = {
                "model": args.model,
                "messages": messages,
                "temperature": 0.0,
                "stream": False
            }
            
            # Añadir max_tokens solo si el proveedor lo soporta
            if args.provider not in ["google"]:
                api_params["max_tokens"] = args.max_tokens
            
            response = client.chat.completions.create(**api_params)
            
            # Extraer respuesta con validación
            if not response or not hasattr(response, 'choices') or not response.choices:
                print(f"❌ Error: La API devolvió una respuesta inválida: {response}")
                soma.log_to_l2("API_ERROR", {"turn": i}, f"Error: Respuesta de API inválida o vacía.")
                break
                
            agent_reply = response.choices[0].message.content
            if agent_reply is None:
                # Algunos modelos (ej. Google Gemini) pueden devolver content=None si hay tool_calls 
                # o si la respuesta está bloqueada. Buscamos tool_calls si existen.
                if hasattr(response.choices[0].message, 'tool_calls') and response.choices[0].message.tool_calls:
                    agent_reply = json.dumps({"tool_calls": "detected_not_supported_yet"})
                else:
                    agent_reply = ""
                    print("⚠️ Advertencia: El modelo devolvió contenido vacío (None).")
        
        except Exception as e:
            print(f"❌ Error de API: {e}")
            if args.debug:
                import traceback
                traceback.print_exc()
            break

        print(f"🤖 Respuesta:\n{agent_reply}")
        
        # Guardar respuesta RAW antes de parsear (para debug)
        soma.log_to_l2("RAW_RESPONSE", {"turn": i, "response": agent_reply[:500]}, "Respuesta cruda del modelo antes de parsear")
        if args.debug:
            raw_file = debug_dir / f"RAW_turn_{i}.txt"
            try:
                raw_file.write_text(
                    f"=== Turno {i} - RESPUESTA RAW DEL MODELO ===\n\n"
                    f"{agent_reply}\n\n"
                    f"=== FIN ===",
                    encoding="utf-8"
                )
            except Exception as e:
                print(f"⚠️ Error guardando respuesta raw: {e}")
        
        action = extract_json(agent_reply)
        if not action:
            print("❌ Error de parseo JSON. Reintentando...")
            # Guardar la respuesta malformada para debug
            if args.debug:
                debug_error_file = debug_dir / f"JSON_ERROR_turn_{i}.txt"
                try:
                    debug_error_file.write_text(
                        f"=== Turno {i} - JSON Parse Error ===\n\n"
                        f"Respuesta del agente:\n{agent_reply}\n\n"
                        f"=== FIN ===",
                        encoding="utf-8"
                    )
                    print(f"💾 Respuesta malformada guardada en: {debug_error_file}")
                except Exception as e:
                    print(f"⚠️ Error guardando debug: {e}")
            soma.log_to_l2("JSON_ERROR", {"raw_response": agent_reply[:200]}, "Error: Envía solo JSON válido.")
            continue
            
        tool = action.get("tool")
        args_tool = action.get("args", {})
        
        print(f"🛠️  Ejecutando: {tool}")
        result, warn = soma.invoke_tool(tool, args_tool)
        
        print(f"📄 Resultado (trunc): {str(result)[:150]}...")
        if warn:
            print(f"⚠️ {warn}")
            
        if tool == "finish_task":
            status = args_tool.get('status', 'N/A').upper()
            print(f"✅ ¡TAREA FINALIZADA POR EL AGENTE! [STATUS: {status}]")
            print(f"Resumen: {args_tool.get('summary')}")
            break
            
        print(f"⏳ Esperando {turn_delay:.1f}s para respetar límite de {args.rpm} RPM...")
        time.sleep(turn_delay)

if __name__ == "__main__":
    run_agent()

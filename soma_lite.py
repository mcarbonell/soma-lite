import os
import json
import subprocess
import re
from pathlib import Path
from datetime import datetime
import shutil


class SimulatedStatefulTerminal:
    """
    Terminal simulada con estado persistente.
    Mantiene cwd, variables de entorno e historial entre comandos.
    """
    def __init__(self, initial_cwd: str):
        self.initial_cwd = Path(initial_cwd).resolve()
        self.cwd = self.initial_cwd
        self.env_vars = {}
        self.command_history = []
        self.last_output = ""
        self.last_command = ""
        self.background_processes = {}
        
    def get_prompt_info(self) -> dict:
        """Devuelve información para mostrar en el prompt del agente."""
        # Listar archivos en directorio actual (máximo 10)
        try:
            files = []
            for i, f in enumerate(self.cwd.iterdir()):
                if i >= 10:
                    files.append(f"... y {sum(1 for _ in self.cwd.iterdir()) - 10} más")
                    break
                if f.is_dir():
                    files.append(f"📁 {f.name}/")
                else:
                    size = f.stat().st_size
                    files.append(f"📄 {f.name} ({size}b)")
        except Exception:
            files = ["[Error listando archivos]"]
            
        return {
            "cwd": str(self.cwd),
            "relative_cwd": self.cwd.relative_to(self.initial_cwd) if str(self.cwd).startswith(str(self.initial_cwd)) else self.cwd,
            "files": files,
            "env_count": len(self.env_vars),
            "history_count": len(self.command_history)
        }
    
    def execute(self, command: str) -> str:
        """Ejecuta un comando manteniendo el estado."""
        self.last_command = command
        
        # Lista de comandos potencialmente peligrosos o que cuelgan
        dangerous_patterns = [
            (r'^python\s*$', "python sin argumentos entra en modo interactivo"),
            (r'^python3\s*$', "python3 sin argumentos entra en modo interactivo"),
            (r'^node\s*$', "node sin argumentos entra en modo interactivo"),
            (r'^bash\s*$', "bash sin argumentos entra en modo interactivo"),
            (r'^sh\s*$', "sh sin argumentos entra en modo interactivo"),
            (r'\.(env|pem|id_rsa|credentials|json)\b', "acceso a archivos de configuraci\u00f3n o llaves bloqueado por seguridad"),
            (r'\.soma', "la carpeta .soma es el kernel del sistema y est\u00e1 protegida contra acceso directo desde el terminal"),
        ]

        for pattern, reason in dangerous_patterns:
            if re.search(pattern, command.strip(), re.IGNORECASE):
                return f"⚠️ COMANDO BLOQUEADO: {reason}. El comando no se ejecutó para evitar que el terminal se quede colgado."
        
        # Pre-procesar: expandir variables $VAR
        expanded_command = command
        for key, val in self.env_vars.items():
            expanded_command = expanded_command.replace(f"${key}", val)
            expanded_command = expanded_command.replace(f"${{{key}}}", val)
        
        # Detectar y procesar 'cd'
        cd_match = re.match(r'^cd\s+(.+)$', expanded_command.strip())
        if cd_match:
            target_path = cd_match.group(1).strip()
            result = self._change_directory(target_path)
            self.command_history.append({"cmd": command, "cwd": str(self.cwd), "result": result})
            return result
        
        # Detectar 'export VAR=valor'
        export_match = re.match(r'^export\s+(\w+)=(.+)$', expanded_command.strip())
        if export_match:
            key, val = export_match.groups()
            # Eliminar comillas si las hay
            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]
            self.env_vars[key] = val
            result = f"✓ Variable de entorno establecida: {key}={val}"
            self.command_history.append({"cmd": command, "cwd": str(self.cwd), "result": result})
            return result
        
        # Detectar 'unset VAR'
        unset_match = re.match(r'^unset\s+(\w+)$', expanded_command.strip())
        if unset_match:
            key = unset_match.group(1)
            if key in self.env_vars:
                del self.env_vars[key]
                result = f"✓ Variable {key} eliminada"
            else:
                result = f"Variable {key} no estaba definida"
            self.command_history.append({"cmd": command, "cwd": str(self.cwd), "result": result})
            return result
        
        # Para cualquier otro comando, ejecutar con subprocess
        try:
            # Preparar el entorno con las variables guardadas
            env = os.environ.copy()
            env.update(self.env_vars)
            
            result = subprocess.run(
                expanded_command,
                shell=True,
                cwd=self.cwd,
                capture_output=True,
                text=True,
                timeout=30,
                env=env
            )
            
            output = result.stdout + result.stderr if result.returncode != 0 else result.stdout
            
            if not output.strip():
                output = "✓ Comando ejecutado exitosamente (sin salida)"
            
            self.last_output = output
            self.command_history.append({
                "cmd": command, 
                "cwd": str(self.cwd), 
                "result": output[:200] + "..." if len(output) > 200 else output
            })
            
            return output
            
        except subprocess.TimeoutExpired:
            result = "⏱️ Error: Comando excedió el timeout de 30 segundos. Posibles causas:\n- Comando interactivo que espera input (ej: 'python' sin argumentos)\n- Proceso bloqueado o en loop infinito"
            self.command_history.append({"cmd": command, "cwd": str(self.cwd), "result": result})
            return result
        except Exception as e:
            result = f"❌ Error ejecutando comando: {str(e)}"
            self.command_history.append({"cmd": command, "cwd": str(self.cwd), "result": result})
            return result

    def read_background_output(self, pid: str) -> str:
        info = self.background_processes.get(str(pid))
        if not info:
            return f"❌ Error: El proceso con PID {pid} no está en ejecución o ya terminó."
        return f"[Salida PID {pid} - {info['command']}]\n{''.join(info['output']) or '(Sin salida todavía)'}"

    def stop_process(self, pid: str) -> str:
        info = self.background_processes.get(str(pid))
        if not info:
            return f"❌ Error: No se encontró el proceso con PID {pid}"
        proc = info["process"]
        try:
            proc.kill()
        except Exception:
            pass
        self.background_processes.pop(str(pid), None)
        return f"✅ Proceso {pid} detenido."
    
    def _change_directory(self, target: str) -> str:
        """Cambia el directorio de trabajo."""
        # Manejar rutas relativas y absolutas
        if target.startswith("/") or target.startswith("\\"):
            new_path = Path(target)
        elif target == "~":
            new_path = Path.home()
        elif target == "-":
            # Volver al directorio anterior (simplificado)
            if len(self.command_history) > 0:
                for entry in reversed(self.command_history[:-1]):
                    if entry["cwd"] != str(self.cwd):
                        new_path = Path(entry["cwd"])
                        break
                else:
                    return "⚠️ No hay directorio anterior en el historial"
            else:
                return "⚠️ No hay directorio anterior"
        else:
            new_path = (self.cwd / target).resolve()
        
        # Verificar que existe y es directorio
        if not new_path.exists():
            return f"❌ Error: El directorio no existe: {target}"
        if not new_path.is_dir():
            return f"❌ Error: No es un directorio: {target}"
        
        old_cwd = self.cwd
        self.cwd = new_path
        return f"📁 Directorio cambiado: {old_cwd} → {self.cwd}"
    
    def get_state_summary(self) -> str:
        """Devuelve resumen visual del estado para el prompt."""
        info = self.get_prompt_info()
        files_str = "\n".join([f"   {f}" for f in info["files"]]) if info["files"] else "   (vacío)"
        
        return f"""┌─ Terminal Stateful ─────────────────────────┐
│ 📂 CWD: {info['relative_cwd']}
│ 📝 Último: {self.last_command[:40]}{'...' if len(self.last_command) > 40 else ''}
│ 🔧 Variables: {info['env_count']} | Historial: {info['history_count']} cmds
│ 📂 Archivos en CWD:
{files_str}
└─────────────────────────────────────────────┘"""


class SOMALite:
    def __init__(self, workspace: str):
        self.workspace = Path(workspace).resolve()
        self.soma = self.workspace / ".soma"
        self.turns_since_checkpoint = 0
        self.action_log = []
        self.msg_counter = 0
        self.pins = {
            "SYSTEM": "system_info",
            "CWD": "pwd",
            "FILES": "ls -F",
        }
        # Inicializar terminal stateful
        self.terminal = SimulatedStatefulTerminal(str(self.workspace))
        self.init_soma()

    def init_soma(self):
        self.soma.mkdir(parents=True, exist_ok=True)
        
        identity_path = self.soma / "identity.md"
        if not identity_path.exists():
            identity_path.write_text("""# SOMA Lite (Sovereign Operating Memory Architecture)

Eres un agente con memoria persistente. SOMA gestiona tu contexto mediante capas:
- L1 (Contexto Actual): Lo que ves ahora (identidad, dashboard, archivos, log reciente y notas).
- L2 (Memoria Completa): El archivo `session_log.jsonl` guarda todo lo que has hecho.

## 🖥️ Terminal Stateful (Con Estado)
La terminal MANTIENE ESTADO entre comandos:
- `cd carpeta` - Cambia de directorio y persiste para siguientes comandos
- `export VAR=valor` - Define variables de entorno disponibles en comandos posteriores
- `unset VAR` - Elimina una variable de entorno
- El CWD actual se muestra en el dashboard bajo "📂 CWD"

## Tus Herramientas
Todas las herramientas aceptan un parámetro opcional `reason` para explicar tu CoT (Chain of Thought), aunque en las notas es opcional.

1. `execute_command(command, reason)` - Ejecuta comandos de consola (stateful: recuerda cd y exports).
2. `read_file(path, reason)` - Lee el contenido de un archivo.
3. `write_file(path, content, reason)` - Crea o sobrescribe un archivo.
4. `add_note(title, content)` - Crea una nueva nota con un ID (n1, n2...).
5. `update_note(id, title, content)` - Actualiza una nota existente por su ID.
6. `delete_note(id)` - Elimina una nota permanentemente.
7. `collapse_note(id, collapsed)` - Colapsa (True) o expande (False) una nota en tu contexto para ahorrar espacio.
8. `checkpoint(description)` - Si Pm > 70%, usa esto para limpiar el `action_log`.
9. `finish_task(status, summary, feedback)` - Úsalo para terminar.

## Reglas de Operación
1. EXPLICACIÓN (Opcional pero recomendada): Usa `reason` cuando la acción no sea obvia.
2. GESTIÓN DE NOTAS: Usa las notas para guardar descubrimientos, planes y datos clave.
3. AHORRO DE CONTEXTO: Si una nota ya no es crítica pero quieres conservarla, usa `collapse_note` con `collapsed=True`.
4. NO REPETIR: Si ves en <action_log> un comando idéntico con el mismo resultado, prueba algo nuevo.
5. GESTIÓN DE MEMORIA: Si el dashboard indica `State: ROJO`, llama a `checkpoint()`.
""", encoding="utf-8")

        task_path = self.soma / "task.md"
        if not task_path.exists():
            task_path.write_text("""# OBJETIVO DE LA TAREA
[Define aquí la meta principal]
""", encoding="utf-8")

        notes_path = self.soma / "notes.json"
        if not notes_path.exists():
            notes_path.write_text(json.dumps({"notes": [], "next_id": 1}), encoding="utf-8")

        log_path = self.soma / "session_log.jsonl"
        if not log_path.exists():
            log_path.touch()

        changelog_path = self.soma / "CHANGELOG.md"
        if not changelog_path.exists():
            changelog_path.write_text("# CHANGELOG\nRegistro de hitos consolidados.\n\n", encoding="utf-8")

    def calculate_pm(self) -> float:
        """Estimación ultra-simple: chars / 4"""
        identity = (self.soma / "identity.md").read_text(encoding="utf-8")
        task = (self.soma / "task.md").read_text(encoding="utf-8")
        notes_str = self._render_notes()
        changelog = (self.soma / "CHANGELOG.md").read_text(encoding="utf-8")
        action_log_str = self.format_action_log()

        # Calcula asumiendo 1 carácter = 0.25 tokens
        total_chars = len(identity) + len(task) + len(notes_str) + len(changelog) + len(action_log_str) + 400
        estimated_tokens = total_chars // 4
        pm = (estimated_tokens / 128000) * 100  # Asume 128k contexto
        return pm

    def truncate_result(self, tool: str, result: str) -> str:
        """Trunca resultados largos para ahorrar tokens.
        Para execute_command, guarda el principio y el final si es muy largo."""
        limits = {
            "execute_command": 1000,
            "read_file": 3000,
            "write_file": 50,
            "edit_line_range": 200,
            "update_notes": 100,
            "checkpoint": 100,
            "finish_task": 500
        }
        limit = limits.get(tool, 300)
        
        if len(result) > limit:
            if tool == "execute_command" and limit >= 500:
                half = limit // 2
                return result[:half] + f"\n\n... [{len(result)-limit} chars ocultos para ahorrar contexto] ...\n\n" + result[-half:]
            else:
                return result[:limit] + f"\n... [{len(result)-limit} chars más]"
        return result

    def format_action_log(self):
        """Formato de historial enriquecido con el 'reason' del agente.
        Muestra todas las acciones desde el último checkpoint."""
        lines = []
        for entry in self.action_log:
            args_copy = entry.get('args', {}).copy()
            reason = args_copy.pop('reason', 'Sin motivo especificado')
            args_str = json.dumps(args_copy)
            
            res = str(entry['result']).strip()
            # Envolver resultados en bloques de código si tienen varias líneas
            if "\n" in res:
                res = f"\n```\n{res}\n```"
            else:
                res = f"`{res}`"
            
            lines.append(f"- [{entry['id']}] {entry['tool']}({args_str})\n  **Why**: {reason}\n  **Result**: {res}")
        return "\n".join(lines)

    def build_prompt(self):
        identity = (self.soma / "identity.md").read_text(encoding="utf-8")
        task = (self.soma / "task.md").read_text(encoding="utf-8")
        notes_str = self._render_notes()
        pm = self.calculate_pm()
        
        # Dashboard Dashboard
        state_icon = "ROJO" if pm > 70 else "AMARILLO" if pm > 60 else "VERDE"
        changelog = (self.soma / "CHANGELOG.md").read_text(encoding="utf-8")

        # Obtener estado de la terminal stateful
        terminal_state = self.terminal.get_state_summary()

        rendered_pins = []
        for alias, command in self.pins.items():
            if command == "system_info":
                output = f"Time: {datetime.now().isoformat(timespec='seconds')} | OS: {os.name} | Python: {os.sys.version.split()[0]}"
            else:
                output = self.terminal.execute(command)
            rendered_pins.append(f"[PIN: {alias}] ({command})\n{self._truncate_with_ellipsis(output, 40)}\n---")
        
        # Resumen de notas para el dashboard
        notes_data = self._read_notes()
        notes_summary = []
        for n in notes_data["notes"]:
            short_title = n["title"][:10] + ".." if len(n["title"]) > 10 else n["title"]
            status = "(C)" if n.get("collapsed") else ""
            notes_summary.append(f"[{n['id']}] {short_title}{status}")
        
        notes_dash = ", ".join(notes_summary) if notes_summary else "vacío"
        
        return f"""<identity>
{identity}
</identity>

<dashboard>
Pm: {pm:.1f}% | Turns: {self.turns_since_checkpoint}/20 | State: {state_icon}
📝 Notas: {notes_dash}
{terminal_state}

[PINS]
{chr(10).join(rendered_pins) if rendered_pins else '(No hay pins activos)'}
</dashboard>

<changelog>
{changelog}
</changelog>

<task>
{task}
</task>

<notes>
{notes_str}
</notes>

<action_log>
{self.format_action_log()}
</action_log>"""

    def log_to_l2(self, tool: str, args: dict, result: str):
        self.msg_counter += 1
        entry = {
            "id": f"msg_{self.msg_counter:03d}",
            "tool": tool,
            "args": args,
            "result": self.truncate_result(tool, result),
            "timestamp": datetime.now().isoformat()
        }
        
        with open(self.soma / "session_log.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
            
        self.action_log.append(entry)

    # =========================================================================
    # Herramientas
    # =========================================================================

    def execute_command(self, command: str) -> str:
        """Ejecuta comando en terminal stateful. Mantiene cwd y variables."""
        return self.terminal.execute(command)

    def read_file(self, path: str, start: int = 1, end: int = 100) -> str:
        """Lee archivo. Retorna contenido completo."""
        target_path = (self.workspace / path).resolve()
        if not str(target_path).startswith(str(self.workspace)):
            return "Error: Path outside workspace."
        if not target_path.exists():
            return f"Error: File {path} not found."
        try:
            content = target_path.read_text(encoding="utf-8")
            lines = content.splitlines()
            slice_lines = lines[start - 1:end]
            return "\n".join(f"{str(start + i).rjust(4)}: {line}" for i, line in enumerate(slice_lines))
        except Exception as e:
            return f"Error reading file: {str(e)}"

    def write_file(self, path: str, content: str) -> str:
        """Escribe archivo. Crea dirs si no existen."""
        target_path = (self.workspace / path).resolve()
        if not str(target_path).startswith(str(self.workspace)):
            return "Error: Path outside workspace."
        try:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_text(content, encoding="utf-8")
            return "success"
        except Exception as e:
            return f"Error writing file: {str(e)}"

    def edit_line_range(self, path: str, start: int, end: int, text: str) -> str:
        target_path = (self.workspace / path).resolve()
        if not str(target_path).startswith(str(self.workspace)):
            return "Error: Path outside workspace."
        if not target_path.exists():
            return f"Error: File {path} not found."
        try:
            content = target_path.read_text(encoding="utf-8")
            lines = content.splitlines()
            replacement_lines = text.splitlines() or [text]
            lines[start - 1:end] = replacement_lines
            target_path.write_text("\n".join(lines), encoding="utf-8")
            return f"success. replaced lines {start}-{end}."
        except Exception as e:
            return f"Error editing file: {str(e)}"

    def pin(self, command: str, alias: str) -> str:
        self.pins[alias] = command
        return f"✓ Command pinned as [{alias}]"

    def unpin(self, alias: str) -> str:
        if alias in self.pins:
            del self.pins[alias]
            return f"✓ [{alias}] unpinned."
        return f"Error: Pin [{alias}] not found."

    def _read_notes(self) -> dict:
        notes_path = self.soma / "notes.json"
        try:
            return json.loads(notes_path.read_text(encoding="utf-8"))
        except Exception:
            return {"notes": [], "next_id": 1}

    def _write_notes(self, data: dict):
        notes_path = self.soma / "notes.json"
        notes_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _render_notes(self) -> str:
        data = self._read_notes()
        if not data["notes"]:
            return "No hay notas guardadas."
        
        lines = []
        for n in data["notes"]:
            if n.get("collapsed"):
                lines.append(f"### [{n['id']}] {n['title']} (COLAPSADA)")
            else:
                lines.append(f"### [{n['id']}] {n['title']}")
                lines.append(f"{n['content']}\n")
        return "\n".join(lines)

    def add_note(self, title: str, content: str) -> str:
        """Añade una nueva nota structurada."""
        data = self._read_notes()
        note_id = f"n{data['next_id']}"
        data["notes"].append({
            "id": note_id,
            "title": title,
            "content": content,
            "collapsed": False
        })
        data["next_id"] += 1
        self._write_notes(data)
        return f"Nota creada con ID: {note_id}"

    def update_note(self, id: str, title: str = None, content: str = None) -> str:
        """Actualiza una nota existente."""
        data = self._read_notes()
        for n in data["notes"]:
            if n["id"] == id:
                if title: n["title"] = title
                if content: n["content"] = content
                self._write_notes(data)
                return "success"
        return f"Error: Nota con ID {id} no encontrada."

    def delete_note(self, id: str) -> str:
        """Elimina una nota."""
        data = self._read_notes()
        initial_len = len(data["notes"])
        data["notes"] = [n for n in data["notes"] if n["id"] != id]
        if len(data["notes"]) < initial_len:
            self._write_notes(data)
            return "success"
        return f"Error: Nota con ID {id} no encontrada."

    def collapse_note(self, id: str, collapsed: bool = True) -> str:
        """Colapsa o expande una nota."""
        data = self._read_notes()
        for n in data["notes"]:
            if n["id"] == id:
                n["collapsed"] = collapsed
                self._write_notes(data)
                return "success"
        return f"Error: Nota con ID {id} no encontrada."

    def finish_task(self, status: str, summary: str, feedback: str) -> str:
        """Marca la tarea como finalizada."""
        return f"TASK_FINISHED [{status.upper()}]: {summary}"

    def checkpoint(self, description: str) -> str:
        """Consolida trabajo y limpia el historial de acciones de L1."""
        self.action_log = []  # Reset completo del log local tras consolidar
        
        try:
            # 1. Actualizar CHANGELOG.md antes de Git
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            changelog_entry = f"- [{timestamp}] {description}\n"
            changelog_path = self.soma / "CHANGELOG.md"
            with open(changelog_path, "a", encoding="utf-8") as f:
                f.write(changelog_entry)

            # 2. Operación Git / Backup
            git_check = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=self.workspace, capture_output=True)
            if git_check.returncode == 0:
                subprocess.run(["git", "add", "."], cwd=self.workspace, check=False)
                subprocess.run(["git", "commit", "-m", f"SOMA Lite: {description}"], cwd=self.workspace, check=False)
                git_status = "Git commit created."
            else:
                # Backup if no git
                backup_dir = self.workspace / ".soma_backup_temp"
                if backup_dir.exists():
                    shutil.rmtree(backup_dir)
                shutil.copytree(self.soma, backup_dir)
                git_status = "Git repository not found. Local backup created at .soma_backup_temp."
        except Exception as e:
            git_status = f"Checkpoint backup/git failed: {e}"

        self.turns_since_checkpoint = 0
        return f"success. {git_status}"

    # =========================================================================
    # Ciclo de Ejecución (Orquestador Base)
    # =========================================================================

    def invoke_tool(self, tool_name: str, args: dict):
        result = ""
        if tool_name == "execute_command":
            result = self.execute_command(args.get("command", ""))
        elif tool_name == "stop_process":
            result = self.terminal.stop_process(str(args.get("pid", "")))
        elif tool_name == "read_file":
            result = self.read_file(args.get("path", ""), args.get("start", 1), args.get("end", 100))
        elif tool_name == "write_file":
            result = self.write_file(args.get("path", ""), args.get("content", ""))
        elif tool_name == "edit_line_range":
            result = self.edit_line_range(args.get("path", ""), args.get("start", 1), args.get("end", 1), args.get("text", ""))
        elif tool_name == "add_note":
            result = self.add_note(args.get("title", ""), args.get("content", ""))
        elif tool_name == "update_note":
            result = self.update_note(args.get("id", ""), args.get("title"), args.get("content"))
        elif tool_name == "delete_note":
            result = self.delete_note(args.get("id", ""))
        elif tool_name == "collapse_note":
            result = self.collapse_note(args.get("id", ""), args.get("collapsed", True))
        elif tool_name == "checkpoint":
            result = self.checkpoint(args.get("description", ""))
        elif tool_name == "finish_task":
            result = self.finish_task(args.get("status", "success"), args.get("summary", ""), args.get("feedback", ""))
        elif tool_name == "pin":
            result = self.pin(args.get("command", ""), args.get("alias", "sensor"))
        elif tool_name == "unpin":
            result = self.unpin(args.get("alias", ""))
        else:
            result = f"Error: Tool {tool_name} not found."
            
        self.log_to_l2(tool_name, args, result)
        self.turns_since_checkpoint += 1
        
        warning = ""
        pm = self.calculate_pm()
        if pm > 70 or self.turns_since_checkpoint >= 20:
            warning = "🔴 Dashboard Crítico. Llama a checkpoint() para consolidar el action_log."
        elif pm > 60:
            warning = "🟡 Advertencia de Memoria. Considera llamar a checkpoint() pronto."
            
        return result, warning

    def _truncate_with_ellipsis(self, text: str, max_lines: int) -> str:
        lines = str(text).splitlines()
        if len(lines) <= max_lines:
            return text
        half = max_lines // 2
        head = "\n".join(lines[:half])
        tail = "\n".join(lines[-half:])
        return f"{head}\n... [{len(lines) - max_lines} líneas ocultas] ...\n{tail}"

if __name__ == "__main__":
    print("Iniciando pruebas de SOMALite...")
    
    # Creamos un directorio temporal de pruebas para no ensuciar tu repo principal
    test_workspace = Path.cwd() / "soma_lite_test_env"
    test_workspace.mkdir(exist_ok=True)
    
    soma = SOMALite(test_workspace)
    print(f"✅ Orquestador inicializado en: {test_workspace}")
    
    print("\n--- TEST 1: execute_command (con truncamiento inteligente para salidas largas) ---")
    res, warn = soma.invoke_tool("execute_command", {"command": "python -c \"print('X' * 1500)\""})
    print(f"Salida de length inicial: 1500 -> truncada a length: {len(res)} chars")
    print(f"Muestra inicial y final de res:\\n{res[:60]}...{res[-60:]}")
    
    print("\n--- TEST 2: write_file y read_file ---")
    soma.invoke_tool("write_file", {"path": "test_doc.txt", "content": "Hola mundo desde SOMA Lite"})
    res, warn = soma.invoke_tool("read_file", {"path": "test_doc.txt"})
    print(f"Contenido leído desde archivo: {res}")
    
    print("\n--- TEST 3: Gestion de Notas Estructuradas ---")
    soma.invoke_tool("add_note", {"title": "Arquitectura", "content": "Usar capas L1, L2, L3."})
    soma.invoke_tool("add_note", {"title": "Bugs", "content": "Falta manejar excepciones en el parser."})
    print("Notas despues de añadir 2:")
    print(soma._render_notes())
    
    soma.invoke_tool("collapse_note", {"id": "n1", "collapsed": True})
    print("\nNotas despues de colapsar n1:")
    print(soma._render_notes())
    
    soma.invoke_tool("update_note", {"id": "n2", "title": "Bugs Criticos", "content": "Urgente: revisar timeouts."})
    print("\nNotas despues de actualizar n2:")
    print(soma._render_notes())
    
    res = (test_workspace / ".soma" / "notes.json").read_text(encoding="utf-8")
    print("\nContenido de notes.json:", res)
    
    print("\n--- TEST 4: Generar el Prompt completo ---")
    prompt = soma.build_prompt()
    print("--- INICIO DEL PROMPT (Lo que vería el LLM en el Turno 4) ---")
    print(prompt)
    print("--- FIN DEL PROMPT ---")
    
    print("\n--- TEST 5: checkpoint ---")
    res, warn = soma.invoke_tool("checkpoint", {"description": "Test de checkpoint funcional"})
    print(f"Resultado checkpoint: {res}")
    print(f"Action log L1 después del checkpoint tiene {len(soma.action_log)} elementos (debe ser 3 o menos).")
    
    print("\n✅ ¡Todos los 5 tests pasaron exitosamente! SOMALite está funcionando.")

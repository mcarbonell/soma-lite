import os
from dataclasses import dataclass
from typing import Optional, Any, Dict, List


@dataclass
class InferenceProviderConfig:
    provider: str
    base_url: Optional[str] = None
    api_key: Optional[str] = None


_FALLBACK_CONTEXT_LENGTHS = {
    "zen": 200_000,
    "openrouter": 128_000,
    "lmstudio": 32_768,
    "openai": 128_000,
    "google": 128_000,
    "anthropic": 200_000,
    "groq": 131_072,
}


def resolve_provider_config(provider: str = "openrouter", base_url: Optional[str] = None, api_key: Optional[str] = None) -> InferenceProviderConfig:
    normalized = (provider or "openrouter").strip().lower()
    if normalized == "openrouter":
        return InferenceProviderConfig(normalized, base_url or "https://openrouter.ai/api/v1", api_key or os.getenv("OPENROUTER_API_KEY"))
    if normalized == "openai":
        return InferenceProviderConfig(normalized, base_url, api_key or os.getenv("OPENAI_API_KEY"))
    if normalized == "google":
        return InferenceProviderConfig(normalized, base_url, api_key or os.getenv("GOOGLE_API_KEY"))
    if normalized == "anthropic":
        return InferenceProviderConfig(normalized, base_url, api_key or os.getenv("ANTHROPIC_API_KEY"))
    if normalized == "groq":
        return InferenceProviderConfig(normalized, base_url or "https://api.groq.com/openai/v1", api_key or os.getenv("GROQ_API_KEY"))
    if normalized == "lmstudio":
        return InferenceProviderConfig(normalized, base_url or "http://localhost:1234/v1", api_key or "lm-studio")
    if normalized == "zen":
        return InferenceProviderConfig(normalized, base_url or "https://opencode.ai/zen/v1", api_key or os.getenv("ZEN_API_KEY"))
    return InferenceProviderConfig(normalized, base_url, api_key or os.getenv("OPENAI_API_KEY"))


class UnifiedInferenceClient:
    def __init__(self, config: InferenceProviderConfig):
        self.config = config
        self.provider = config.provider
        self.client = self._init_client()

    def _init_client(self):
        if self.provider == "google":
            from google import genai
            return genai.Client(api_key=self.config.api_key)
        if self.provider == "anthropic":
            from anthropic import Anthropic
            return Anthropic(api_key=self.config.api_key)
        from openai import OpenAI
        return OpenAI(base_url=self.config.base_url, api_key=self.config.api_key)

    @property
    def chat(self):
        return self

    @property
    def completions(self):
        return self

    def create(self, model: str, messages: List[Dict[str, Any]], **kwargs):
        if self.provider == "google":
            system = next((m["content"] for m in messages if m["role"] == "system"), None)
            convo = [{"role": "user" if m["role"] == "user" else "model", "parts": [{"text": m["content"]}]} for m in messages if m["role"] != "system"]
            response = self.client.models.generate_content(
                model=f"models/{model}" if not model.startswith("models/") else model,
                contents=convo,
                config={"system_instruction": system, "temperature": kwargs.get("temperature", 0.0), "max_output_tokens": kwargs.get("max_tokens")},
            )
            return type("Resp", (), {"choices": [type("Choice", (), {"message": type("Msg", (), {"content": getattr(response, "text", "")})()})()]})()
        if self.provider == "anthropic":
            system = next((m["content"] for m in messages if m["role"] == "system"), None)
            convo = [{"role": m["role"], "content": m["content"]} for m in messages if m["role"] != "system"]
            response = self.client.messages.create(model=model, system=system, messages=convo, max_tokens=kwargs.get("max_tokens", 4096), temperature=kwargs.get("temperature", 0.0))
            text = response.content[0].text if response.content else ""
            return type("Resp", (), {"choices": [type("Choice", (), {"message": type("Msg", (), {"content": text})()})()]})()
        return self.client.chat.completions.create(model=model, messages=messages, **kwargs)


def create_inference_client(config: InferenceProviderConfig) -> UnifiedInferenceClient:
    return UnifiedInferenceClient(config)


def get_effective_max_tokens(config: InferenceProviderConfig, model: str, user_override: Optional[int] = None) -> int:
    if user_override:
        return user_override
    return _FALLBACK_CONTEXT_LENGTHS.get(config.provider, 128_000)


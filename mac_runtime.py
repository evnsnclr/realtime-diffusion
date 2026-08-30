"""Lazy, serialized StreamDiffusion inference using Apple's MPS backend."""

from __future__ import annotations

from io import BytesIO
import os
import threading
import time


os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def _env_setting(name: str, default: str) -> str:
    """Read a SURFACESHIFT_* setting, honoring the legacy CLAY_SCREEN_* name."""
    value = os.getenv(f"SURFACESHIFT_{name}")
    if value is None:
        value = os.getenv(f"CLAY_SCREEN_{name}")
    return default if value is None else value


class MacDiffusionEngine:
    """Load SD-Turbo on first use and transform one newest frame at a time."""

    width = int(_env_setting("WIDTH", "512"))
    height = int(_env_setting("HEIGHT", "288"))
    model_id = _env_setting("MODEL", "stabilityai/sd-turbo")
    vae_id = _env_setting("VAE", "madebyollin/taesd")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stream = None
        self._last_prompt = ""
        self._device = "mps"

    def status(self) -> dict[str, object]:
        try:
            import torch

            mps_available = torch.backends.mps.is_available()
        except (ImportError, AttributeError):
            mps_available = False
        return {
            "device": self._device,
            "mps_available": mps_available,
            "model_loaded": self._stream is not None,
            "width": self.width,
            "height": self.height,
        }

    def _load(self, prompt: str, warmup_image) -> None:
        try:
            import torch
            from diffusers import AutoencoderTiny, StableDiffusionPipeline
            from streamdiffusion import StreamDiffusion
        except ImportError as error:
            raise RuntimeError(
                "The Mac AI dependencies are missing. Run ./setup_mac.sh first."
            ) from error

        if not torch.backends.mps.is_available():
            raise RuntimeError(
                "Apple MPS is unavailable. SurfaceShift's local AI mode requires an Apple Silicon Mac."
            )

        device = torch.device("mps")
        dtype = torch.float16
        pipe = StableDiffusionPipeline.from_pretrained(
            self.model_id,
            torch_dtype=dtype,
            safety_checker=None,
            requires_safety_checker=False,
        ).to(device=device, dtype=dtype)
        pipe.set_progress_bar_config(disable=True)

        stream = StreamDiffusion(
            pipe,
            t_index_list=[15, 25],
            torch_dtype=dtype,
            width=self.width,
            height=self.height,
            frame_buffer_size=1,
            use_denoising_batch=True,
            cfg_type="none",
        )
        stream.vae = AutoencoderTiny.from_pretrained(self.vae_id).to(
            device=device,
            dtype=dtype,
        )
        stream.prepare(
            prompt,
            negative_prompt="blurry, illegible, watermark, low quality",
            num_inference_steps=30,
            guidance_scale=1.0,
            seed=42,
        )

        # The denoising batch needs at least one pass per selected timestep.
        for _ in range(2):
            stream(warmup_image)

        self._stream = stream
        self._last_prompt = prompt

    def transform(
        self,
        payload: bytes,
        prompt: str,
        strength: float,
    ) -> tuple[bytes, float]:
        from PIL import Image, ImageOps, UnidentifiedImageError

        try:
            source = Image.open(BytesIO(payload)).convert("RGB")
        except (UnidentifiedImageError, OSError) as error:
            raise ValueError("The uploaded frame is not a readable image") from error

        source = ImageOps.fit(
            source,
            (self.width, self.height),
            method=Image.Resampling.LANCZOS,
        )

        with self._lock:
            if self._stream is None:
                self._load(prompt, source)
            elif prompt != self._last_prompt:
                self._stream.update_prompt(prompt)
                self._last_prompt = prompt

            started = time.perf_counter()
            result = self._stream(source)
            from streamdiffusion.image_utils import postprocess_image

            generated = postprocess_image(result.cpu(), output_type="pil")[0]
            inference_ms = (time.perf_counter() - started) * 1000

        # The UI strength is an honest source/generated blend. It does not
        # rebuild the diffusion schedule between live frames.
        output = Image.blend(source, generated.convert("RGB"), float(strength))
        buffer = BytesIO()
        output.save(buffer, format="JPEG", quality=82, optimize=True)
        return buffer.getvalue(), inference_ms

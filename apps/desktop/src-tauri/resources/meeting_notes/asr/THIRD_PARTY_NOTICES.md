# Kuku meeting-notes local transcription notices

Kuku downloads the following models only when the local meeting-note feature is first used. Model files remain in the app data directory and inference runs on the user's Mac.

- Qwen3-ASR-0.6B-8bit: derived from Qwen3-ASR and distributed by the `mlx-community` organization under the Apache License 2.0. Review the downloaded `README.md` and model card at <https://huggingface.co/mlx-community/Qwen3-ASR-0.6B-8bit>.
- Streaming Sortformer 4-speaker v2.1 fp16: distributed by the `mlx-community` organization under the NVIDIA Open Model License. Review the downloaded `README.md` and model card at <https://huggingface.co/mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16>.
- mlx-qwen3-asr: MLX inference runtime, <https://github.com/moona3k/mlx-qwen3-asr>.
- MLX Audio: local audio inference utilities, <https://github.com/Blaizzy/mlx-audio>.
- MLX: Apple machine-learning framework, <https://github.com/ml-explore/mlx>.

The exact Python dependency versions used by this build are listed in `requirements.lock` beside this notice.

## On-demand runtime

Kuku ports the Ulpaso meeting engine under the MIT license. The original
copyright notice is included in `../ULPASO_LICENSE`. The model pins, checksums,
and Python dependency lock are preserved from Ulpaso commit `bb502e4`.

The runtime and models are **not bundled** in the Kuku application. They are
installed on first use after consent, under the current Kuku variant's
`plugins/meeting-notes/` data directory. Kuku does not reuse or alter Ulpaso data.

- CPython 3.12.13 uses the Python Software Foundation License. The installed Python distribution retains its license files.
- Package license files remain in the installed `*.dist-info/licenses/` directories under `ASR Runtime/lib/python3.12/site-packages/`.
- The runtime includes MLX and MLX Metal (MIT), NumPy and SciPy (BSD), Hugging Face Hub and Transformers (Apache-2.0), tokenizers and safetensors (Apache-2.0), tqdm (MPL-2.0 and MIT), and their pinned transitive dependencies.
- The pinned `uv` setup tool is downloaded and checksum-verified on first use. It is retained in `ASR Tools`, together with its managed Python and cache. It is not shipped inside the application.

Model cards and their accompanying license information remain in each model's
download directory. The descriptions above are carried forward from Ulpaso;
consult those licenses before redistribution of model weights or a prebuilt runtime.

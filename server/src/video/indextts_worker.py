"""常驻进程：IndexTTS-2.5（MLX）只加载一次，stdin 每行一句，写出 wav。"""
import json
import sys

from index_tts_2_5_mlx import IndexTTS


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    tts = IndexTTS()
    speaker = None
    speaker_ref = ""
    emit({"ready": True})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
            ref = req["ref"]
            if ref != speaker_ref:
                speaker = tts.build_speaker(ref)
                speaker_ref = ref
            tts.clone(req["text"], ref_audio_path=None, spk=speaker, out=req["out"], lang="zh")
            emit({"ok": True})
        except Exception as err:
            emit({"ok": False, "error": str(err)})


if __name__ == "__main__":
    main()

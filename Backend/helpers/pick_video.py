import json
import os
import sys


def main():
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception:
        print(json.dumps({
            "success": False,
            "error": "LOCAL_FILE_PICKER_UNAVAILABLE",
            "message": "Local file picker is unavailable. Make sure Python with tkinter is installed.",
            "suggestion": "Install Python from python.org with tkinter support, or paste a local file path manually."
        }))
        return

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    file_path = filedialog.askopenfilename(
        title="Choose Video",
        filetypes=[
            ("Video files", "*.mp4 *.mkv *.mov *.avi *.webm *.m4v"),
            ("All files", "*.*"),
        ],
    )
    root.destroy()

    if not file_path:
        print(json.dumps({
            "success": False,
            "cancelled": True,
            "message": "No file selected"
        }))
        return

    _, extension = os.path.splitext(file_path)
    print(json.dumps({
        "success": True,
        "videoPath": file_path,
        "fileName": os.path.basename(file_path),
        "extension": extension.lower()
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "success": False,
            "error": "LOCAL_FILE_PICKER_FAILED",
            "message": str(error),
            "suggestion": "Retry the picker or paste the local file path manually."
        }))
        sys.exit(1)

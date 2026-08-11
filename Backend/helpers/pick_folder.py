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
            "error": "LOCAL_FOLDER_PICKER_UNAVAILABLE",
            "message": "Local folder picker is unavailable. Make sure Python with tkinter is installed.",
            "suggestion": "Install Python from python.org with tkinter support, then retry."
        }))
        return

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    folder_path = filedialog.askdirectory(title="Choose Output Folder")
    root.destroy()

    if not folder_path:
        print(json.dumps({
            "success": False,
            "cancelled": True,
            "message": "No folder selected"
        }))
        return

    print(json.dumps({
        "success": True,
        "folderPath": folder_path,
        "folderName": os.path.basename(folder_path.rstrip("\\/"))
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "success": False,
            "error": "LOCAL_FOLDER_PICKER_FAILED",
            "message": str(error),
            "suggestion": "Retry the picker."
        }))
        sys.exit(1)

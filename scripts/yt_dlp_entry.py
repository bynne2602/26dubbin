"""Standalone yt-dlp entry point bundled with curl_cffi impersonation support."""
import sys

from yt_dlp import main


if __name__ == "__main__":
    sys.exit(main())

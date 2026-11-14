# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Entry point: ``python -m app`` starts the HTTP server."""

import logging
import os


def main() -> None:
    import uvicorn

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8890")),
        workers=1,
        access_log=False,
        server_header=False,
        date_header=False,
        # Bound the number of open connections; the extraction queue itself
        # is bounded separately by EXTRACT_CONCURRENCY.
        limit_concurrency=64,
        timeout_keep_alive=5,
        log_config=None,
    )


if __name__ == "__main__":
    main()

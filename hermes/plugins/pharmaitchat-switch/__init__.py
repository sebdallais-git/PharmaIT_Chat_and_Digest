"""pharmaitchat-switch: confirms or cancels a PharmaITChat stack switch from the Telegram buttons the app sends.

The app shares Hermes' bot and Hermes' gateway is that bot's only getUpdates consumer, so a tap on the
app's buttons lands here. The handler is scoped to ``pls:`` callback data and registered before
Hermes' own catch-all, so every other button keeps working.

The ready file PharmaITChat checks is written only once the adapter is connected with this plugin's handler
in place. A Telegram app rebuilt by a transient init retry gets only Hermes' own handlers, so the plugin
re-attaches its handler there, ahead of Hermes' catch-all, before writing the file."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Optional

from .tap import PATTERN, is_allowed, parse_tap, resolve

logger = logging.getLogger(__name__)
READY_FILE_NAME = "pharmaitchat-switch.ready.json"
# Strong references to the ready-file publishers: the loop keeps only weak ones to its tasks
_pending: set[asyncio.Task] = set()


def register(ctx) -> None:
    ctx.register_telegram_handler(_wire)


def _wire(app, adapter) -> None:
    # Runs only when the gateway's Telegram adapter connects. A CLI session loads plugins too but never
    # gets here, so it cannot overwrite the ready file with its own pid.
    from gateway.status import get_process_start_time
    from hermes_constants import get_process_hermes_home

    # The launch home, like gateway.pid and gateway.sock: get_hermes_home() honours per-session
    # profile overrides, which would put the file where PharmaITChat never looks
    home = Path(get_process_hermes_home())
    # A file left by an earlier connect must not vouch for this one while it is still in progress
    (home / READY_FILE_NAME).unlink(missing_ok=True)
    for task in list(_pending):  # an earlier connect's publisher would only log a spurious error
        task.cancel()
    attach_handler(app)
    pid = os.getpid()
    # Same function the gateway's own pid record uses, so PharmaITChat can compare the two exactly.
    # The factory runs inside the adapter's connect() coroutine, so there is a running loop.
    task = asyncio.get_running_loop().create_task(
        publish_ready_when_connected(adapter, app, home, pid, get_process_start_time(pid)))
    _pending.add(task)
    task.add_done_callback(_pending.discard)


def attach_handler(app) -> None:
    """Registers the tap handler FIRST in group 0. python-telegram-bot hands an update to the first
    matching handler of each group, and Hermes' own catch-all for every button sits in group 0: behind
    it, a switch tap would never arrive. On the first build this is where Hermes wires plugins anyway;
    on a rebuilt app Hermes' handlers are already there, so the handler is moved to the front."""
    from telegram.ext import CallbackQueryHandler

    # block=False: the tap waits on the app, and a blocking handler would hold up every other update
    handler = CallbackQueryHandler(handle_tap, pattern=PATTERN, block=False)
    app.add_handler(handler)
    group = app.handlers[0]
    group.remove(handler)
    group.insert(0, handler)


async def publish_ready_when_connected(adapter, app, home: Path, pid: int, start_time: Optional[int],
                                       poll: float = 0.5, timeout: float = 120.0) -> None:
    # connect() can still fail after the factory ran, or rebuild its Application on a transient init
    # error without re-running plugin factories: only a connected adapter still on our app gets a file.
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not adapter.is_connected:
        if loop.time() >= deadline:
            logger.warning("pharmaitchat-switch: Telegram did not connect within %.0f s; no ready file", timeout)
            return
        await asyncio.sleep(poll)
    current = getattr(adapter, "_app", app)
    if current is not app:
        # A retry inside connect() rebuilt the Application without running plugin factories again
        # (seen 2026-09-28 03:11): put the handler on the app that is actually polling
        try:
            attach_handler(current)
        except Exception as exc:
            logger.error("pharmaitchat-switch: Telegram app was rebuilt and the handler could not be "
                         "re-attached (%s); restart the gateway", type(exc).__name__)
            return
        logger.warning("pharmaitchat-switch: Telegram app was rebuilt during connect; handler re-attached")
    write_ready_file(home, pid, start_time)


def write_ready_file(home: Path, pid: int, start_time: Optional[int]) -> Path:
    path = home / READY_FILE_NAME
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps({"pid": pid, "start_time": start_time}), encoding="utf-8")
    os.replace(temp, path)
    return path


async def _answer(query, text: str) -> None:
    # A late or duplicate answer can be rejected by Telegram; that must never stop the handler
    # (in particular, the edit below still needs to run) or surface as a gateway error.
    try:
        await query.answer(text=text)
    except Exception as exc:
        logger.warning("pharmaitchat-switch: could not answer the tap (%s)", type(exc).__name__)


async def handle_tap(update, context) -> None:
    query = update.callback_query
    tap = parse_tap(getattr(query, "data", None))
    if query is None or tap is None:
        return
    if not is_allowed(getattr(query.from_user, "id", None), os.environ):
        await _answer(query, "Not authorised")
        return
    # urllib blocks: keep it off the gateway's event loop. resolve()/post_json() never raise: every
    # failure to reach the app comes back as an AppReply/Outcome, so the query is always answered.
    outcome = await asyncio.to_thread(resolve, tap, dict(os.environ))
    await _answer(query, outcome.toast)
    if outcome.text is None:
        return
    try:
        await query.edit_message_text(outcome.text)
    except Exception as exc:  # an edit failure must not surface as a gateway error
        logger.warning("pharmaitchat-switch: could not edit the message (%s)", type(exc).__name__)

"""Chat Tree, the Python half: model-written digests for the Desktop tree pane.

register(ctx) registers the chat_tree_digest auxiliary task and binds ctx into the shared
digest module. The POST /api/plugins/chat-tree/digest route (dashboard/plugin_api.py) reads it
there. dashboard/digest.py explains why both halves share that module.
"""

import importlib.util
import sys
from pathlib import Path

_SHARED_NAME = "chat_tree_digest"  # dashboard/digest.py SHARED_NAME; plugin_api.py uses the same name
_DIGEST_FILE = Path(__file__).resolve().parent / "dashboard" / "digest.py"


def _digest():
    """The one copy of dashboard/digest.py in this process."""
    module = sys.modules.get(_SHARED_NAME)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(_SHARED_NAME, _DIGEST_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return sys.modules.setdefault(_SHARED_NAME, module)


def register(ctx):
    digest = _digest()
    # Digests follow the title-generation model (a cheap slot) until the user sets
    # auxiliary.chat_tree_digest (website/docs/developer-guide/plugin-llm-access.md, task routing).
    ctx.register_auxiliary_task(
        digest.TASK,
        display_name="Chat Tree digests",
        description="Fork and merge digests in the Chat Tree pane",
        inherit_from="title_generation",
    )
    digest.bind(ctx)

    def _unload():
        digest.unbind(ctx)
        # The next load reads digest.py again, so an updated file takes effect without a restart.
        if sys.modules.get(_SHARED_NAME) is digest:
            sys.modules.pop(_SHARED_NAME, None)

    ctx.on_unload(_unload)

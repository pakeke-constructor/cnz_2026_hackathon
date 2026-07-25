


from _ex6.provider_openai import invoke_llm as invoke_llm_openai
from _ex6.models import M
from _ex6.tools import read_headers, read_body, glob, search, write_file, edit_file, read_file, edit_file_lines, escalate, bash, explore_agent, CLAUDE_MD, ENV_PROMPT, git_working_tree, add_tool_repetition_guard, powershell, ask_user_question
from _ex6.skills import load_skill
from _ex6.tasks import plan_add_log, plan_done, plan_list, plan_read, plan_write
from _ex6.web_tools import websearch_agent
from _ex6.provider import cache_manually
import ex6
from ex6 import Context, Message




MAIN_SYSTEM_PROMPT = ex6.Message(
role ="system",
overview="main-system",
content="""\
You are a coding agent working alongside an experienced engineer in a terminal UI.

<goal>
Solve user request with minimal bloat.
Prefer direct implementation path.
</goal>

<agent_strategy>
- Understand request, constraints, user intent first.
- Map out problem + solution, and discover more about the codebase. Prioritize read_headers.
- Complete changes: write code, edit files.

Always check changes afterwards. (Check git diff / read file(s).)
</agent_strategy>

<agent_tactics>
- Try the simplest approach first. Don't overthink.
- Tool call(s) to verify, then act. Don't read the whole codebase before a 2-line edit.
- If a search returns what you need, stop searching. Don't keep exploring "just in case."
- If your approach is blocked, don't brute force. Step back, try a different angle, or ask.
- Avoid backwards-compatibility hacks. If something is unused, delete it.
</agent_tactics>

<output_rules>
Plain text only. No markdown headers, no tables, no emojis. Short lines.
DO NOT explain your reasoning or thinking process. DO NOT narrate what you are about to do or what you just did.
When you have tool calls to make, make them IMMEDIATELY — no preamble, no "Let me look at...", no "I'll now...".
After tool calls, say nothing unless there's a result to report or a question to ask.
The ONLY acceptable text output is: a direct answer, a clarifying question, or a blocker.
</output_rules>

<code_editing_rules>
- Don't add features, refactor, docstrings, comments, or type annotations beyond what was asked.
- Don't add error handling for scenarios that can't happen.
- Three similar lines > premature abstraction.
</code_editing_rules>

<working_style>
- Read code before modifying it. Never propose changes to code you haven't seen.
- Before using an API or module, look up the actual definition first.
- Write the simplest code that works. Avoid over-engineering, unnecessary abstractions, and speculative features.
- Prefer editing existing files over creating new ones.
</working_style>
"""
)




# SMART_MODEL = "openai/gpt-5.2-codex"
# SMART_MODEL = "openai/gpt-5.1-codex-mini"
# SMART_MODEL = M.SONNET_46.id



MAIN_TOOLS = [
    read_file, glob, search, read_headers, read_body,
    write_file, edit_file, edit_file_lines,
    powershell,
    websearch_agent,
    # web_search, websearch_agent,
    plan_done, plan_read, plan_write,
    ask_user_question,
    git_working_tree,
    load_skill
]

MAIN_SYSTEM_PROMPT = MAIN_SYSTEM_PROMPT.with_tools(MAIN_TOOLS)



CLAUDE_MD = ex6.Message(role="system", content=open("CLAUDE.md","r").read(), overview="CLAUDE.md")


MESSAGES = [
    MAIN_SYSTEM_PROMPT,
    ENV_PROMPT,
    CLAUDE_MD,
]


c_opus = Context("c_opus", yolo=False, model=M.OPUS_LATEST.id, reasoning="high", messages=MESSAGES)
cache_manually(c_opus)


c_sonnet = Context("c_sonnet", yolo=False, model=M.SONNET_LATEST.id, reasoning="high", messages=MESSAGES)
cache_manually(c_sonnet)


c_gem = Context("c_gem", yolo=False, model=M.GEMINI_LATEST.id, reasoning="high", messages=MESSAGES)
add_tool_repetition_guard(c_gem)


Context("c_zglm", yolo=False, model=M.GLM_LATEST.id, reasoning="high", messages=MESSAGES)


Context("sub_SOL", model=M.GPT_LATEST.id, reasoning="high", messages=MESSAGES, invoke_llm=invoke_llm_openai)
terra = Context("sub_TERRA", model=M.GPT_TERRA_LATEST.id, reasoning="high", messages=MESSAGES, invoke_llm=invoke_llm_openai)
Context("sub_LUNA", model=M.GPT_LUNA_LATEST.id, reasoning="high", messages=MESSAGES, invoke_llm=invoke_llm_openai)




ex6.set_current(terra)



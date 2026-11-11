"""Write the demo main chat as a Claude Code transcript, for `hermes sessions import --from claude`.

Run: python3 docs/demo/make_main_chat.py > docs/demo/ship-tidyfiles.jsonl
The import makes the main chat with no model call. Some replies carry ::termline markup, so
concept-links draws chips on the imported text.
"""
import json
import uuid

SESSION = "6f1c2d3e-0000-4000-8000-00000000d3a0"

EXCHANGES = [
    ("I want to publish my CLI tool tidyfiles to PyPI. Where do I start?",
     "Three steps get you there.\n\n"
     "1. Describe the package in pyproject.toml.\n"
     "2. Build the files that pip installs.\n"
     "3. Upload them to PyPI.\n\n"
     "Start with pyproject.toml. Everything else reads from it."),
    ("What goes in pyproject.toml?",
     '::termline{v="The file names your **build backend** and holds your project metadata: name, version, dependencies, and scripts." '
     't="build backend=The tool that turns your source tree into installable files, such as hatchling or setuptools."}\n\n'
     "Use hatchling unless you have a reason not to. It needs almost no configuration."),
    ("How do I build the package?",
     "Run `python -m build` in the project root.\n\n"
     '::termline{v="It writes two files to dist/: a **wheel** and an **sdist**." '
     't="wheel=A built package that pip installs by unzipping, with no build step on the user machine.;;'
     'sdist=A source distribution: your source code plus metadata, which pip must build before it installs."}'),
    ("Which license should I pick?",
     "For a small tool that you want people to use freely, pick MIT. Put the text in LICENSE "
     'and set license = "MIT" in pyproject.toml.'),
    ("How do I make `tidyfiles` a command people can run?",
     "Add an entry point:\n\n```toml\n[project.scripts]\ntidyfiles = \"tidyfiles.cli:main\"\n```\n\n"
     "After install, pip puts a tidyfiles command on the PATH."),
    ("How should I number versions?",
     '::termline{v="Use **semantic versioning**: MAJOR.MINOR.PATCH." '
     't="semantic versioning=A version scheme where MAJOR changes break users, MINOR adds features, and PATCH fixes bugs."}\n\n'
     "Start at 0.1.0. Go to 1.0.0 when you promise a stable interface."),
    ("Can I test the upload before the real one?",
     "Yes. Upload to TestPyPI first:\n\n```bash\npython -m twine upload --repository testpypi dist/*\n```\n\n"
     "Then install it from there in a clean virtual environment and run tidyfiles once."),
    ("Can GitHub Actions publish releases for me?",
     '::termline{v="Yes. Use **trusted publishing**, so you store no PyPI token in GitHub." '
     't="trusted publishing=PyPI accepts an upload from a named GitHub workflow, which proves who it is with a short-lived OIDC token."}\n\n'
     "You register the repository and workflow on PyPI once. Then each tagged release publishes itself."),
    ("Will my README show on the PyPI page?",
     'Yes. Set readme = "README.md" in pyproject.toml. PyPI renders Markdown, so keep your examples in fenced code blocks.'),
    ("Should I keep a changelog?",
     "Yes. Keep CHANGELOG.md with one section per version, newest first. Your release notes then write themselves."),
    ("OK, give me the release checklist.",
     "1. Bump the version in pyproject.toml.\n"
     "2. Add the version to CHANGELOG.md.\n"
     "3. Build, then upload to TestPyPI and test.\n"
     "4. Tag the commit, for example v0.1.0, and push the tag.\n"
     "5. The workflow publishes to PyPI."),
]


def line(role, text):
    return json.dumps({
        "type": role,
        "sessionId": SESSION,
        "uuid": str(uuid.uuid4()),
        "message": {"role": role, "content": text},
    })


if __name__ == "__main__":
    for question, answer in EXCHANGES:
        print(line("user", question))
        print(line("assistant", answer))

# Installed as /etc/profile.d/autoworker-path.sh in the image.
#
# Debian's /etc/profile sets PATH to a fixed list in every login shell. "Run
# command" blocks (`bash -lc`), the web shell (`bash -l`) and the shells Claude
# starts are login shells, so without this file they would lose the directory
# with the workflow's runtimes and fall back to the Node.js that ships in the
# image. The server passes the intended PATH in AUTOWORKER_SANDBOX_PATH (see
# server/src/sandbox/agent.ts); this puts it back.
if [ -n "${AUTOWORKER_SANDBOX_PATH-}" ]; then
  PATH="$AUTOWORKER_SANDBOX_PATH"
  export PATH
fi

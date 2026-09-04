#!/bin/sh
set -eu

compiler="$1"
main_file="$2"
export HOME=/tmp
export TEXMFVAR=/tmp/texmf-var
export TEXMFCONFIG=/tmp/texmf-config
export TEXMFCACHE=/tmp/texmf-cache
case "$compiler" in
  pdflatex) engine_flag="-pdf" ;;
  xelatex) engine_flag="-xelatex" ;;
  lualatex) engine_flag="-lualatex" ;;
  *) echo "Unsupported compiler: $compiler" > /output/build.log; exit 64 ;;
esac

mkdir -p /tmp/source /tmp/output "$TEXMFVAR" "$TEXMFCONFIG" "$TEXMFCACHE"
cp -R /input/. /tmp/source/
cd /tmp/source
set +e
latexmk -f "$engine_flag" -interaction=nonstopmode -file-line-error -synctex=1 -no-shell-escape -outdir=/tmp/output "./$main_file" > /output/build.log 2>&1
status=$?
set -e

base_name="$(basename "$main_file" .tex)"
if [ -f "/tmp/output/$base_name.pdf" ]; then cp "/tmp/output/$base_name.pdf" /output/output.pdf; fi
if [ -f "/tmp/output/$base_name.synctex.gz" ]; then cp "/tmp/output/$base_name.synctex.gz" /output/output.synctex.gz; fi
exit "$status"

#!/bin/bash

# Check if the directory is provided as an argument
if [ -z "$1" ]; then
    echo "Usage: $0 <directory>"
    exit 1
fi

# Get the directory from the arguments
DIR="$1"

echo "$DIR"

# Find all files and directories within the given directory
find "$DIR" | while IFS= read -r f; do
    # Replace spaces with hyphens in the file/directory name
    new_name=$(echo "$f"| tr ' ' '-')
    # Rename the file/directory
    if [ "$f" != "$new_name" ]; then mv "$f" "$new_name" ; fi
done

echo "All spaces in file names have been replaced with hyphens."

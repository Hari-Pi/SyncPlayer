export function copyText(value: string) {
  if (!value) {
    return;
  }

  void navigator.clipboard?.writeText(value);
}

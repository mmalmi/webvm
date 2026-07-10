const color = "\x1b[1;35m";
const normal = "\x1b[0m";
const introBorder = "+~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~+";
const introLine = (text = "") => `| ${text.padEnd(75)} |`;
export const introMessage = [
  introBorder,
  introLine(),
  introLine("Iris WebVM is an Alpine Linux workstation running in your browser."),
  introLine("Its local Ethernet link uses FIPS; public networking starts disabled."),
  introLine(),
  introLine("Run webvm-pair to show the Nostr VPN pairing QR code and URI."),
  introLine("Hashtree, git-remote-htree, nhash.iris.localhost, and .fips work now."),
  introLine("After approval, nvpn0 carries DNS and Internet traffic via your exit."),
  introLine(),
  introLine("WebVM is powered by the CheerpX x86-to-WebAssembly virtualization engine."),
  introLine(),
  introBorder,
  "",
  "   Welcome to Iris WebVM. Useful commands:",
  "",
  "     webvm-pair",
  "     htree --help",
  "     git-remote-htree --help",
  "     python3 examples/python3/fibonacci.py ",
  "     gcc -o helloworld examples/c/helloworld.c && ./helloworld",
  "     curl --proto '=https' https://example.com  # after VPN approval",
  "",
];
export const errorMessage = [
  color + "CheerpX could not start" + normal,
  "",
  "Check the DevTools console for more information",
  "",
  "CheerpX is expected to work with recent desktop versions of Chrome, Edge, Firefox and Safari",
  "",
  "Give it a try from a desktop version / another browser!",
  "",
  "CheerpX internal error message is:",
  "",
];
export const unexpectedErrorMessage = [
  color + "WebVM encountered an unexpected error" + normal,
  "",
  "Check the DevTools console for further information",
  "",
  "Please consider reporting a bug!",
  "",
  "CheerpX internal error message is:",
  "",
];

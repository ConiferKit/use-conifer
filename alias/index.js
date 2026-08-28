// @conifer/sdk is a SCOPE-DEFENDING ALIAS, not the package you want.
//
// The real package is `conifer-sdk`, unscoped. This one exists so the
// @conifer scope cannot be squatted by someone publishing malware under a
// name that looks official, and so anyone who guesses the scoped name gets
// the real SDK plus a pointer rather than a 404.
//
// Everything is re-exported verbatim; there is no wrapper behavior here.
export * from "conifer-sdk";

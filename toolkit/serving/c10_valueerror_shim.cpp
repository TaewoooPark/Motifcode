// The one symbol the vendored deep_gemm needs and torch 2.11 no longer exports.
//
// `c10::ValueError` gained `using Error::Error;`, which makes the inherited
// constructor implicit and inline — nothing is emitted, so a binary built
// against an older torch finds 427 of its 428 symbols and fails on the last.
//
// This is a shim, not a fix, and the distinction matters: it asserts that the
// only difference between the two torches, as far as this binary is concerned,
// is where that constructor lives. 427 symbols resolving is evidence for that
// and not proof — a struct whose layout changed silently would corrupt rather
// than fail. So the numerics this enables have to be checked against the
// reference implementation before any of them are believed.

#include <new>
#include <string>
#include <utility>

#include <c10/util/Exception.h>

// The complete-object constructor, under the exact name the binary imports.
// Declaring it with the real C++ signature is what makes the calling
// convention match: on AArch64 a non-trivial class argument is passed by
// invisible reference, and writing this as `extern "C"` with a pointer would
// quietly disagree with the caller.
void motif_c10_valueerror_ctor(c10::ValueError* self, c10::SourceLocation loc, std::string msg)
    __asm__("_ZN3c1010ValueErrorC1ENS_14SourceLocationENSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE");

void motif_c10_valueerror_ctor(c10::ValueError* self, c10::SourceLocation loc, std::string msg) {
  ::new (static_cast<void*>(self)) c10::ValueError(loc, std::move(msg));
}

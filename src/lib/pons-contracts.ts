/** Pons official v2 docs and public app factory→hook registry, checked on chain.
 * Runtime hashes bind this paper adapter to the inspected deployments. */
export const PONS_DOCS = "https://docs.ponsfamily.com/v2";
export const PONS_LOCKER_HASH =
  "0x58455f80b3773871d601a025e56ec27c71ab3bbb8e2ca6b17828954450742025";
export const PONS_STACKS: readonly {
  factory: string;
  hook: string;
  locker: string;
  factoryHash: string;
  hookHash: string;
  lockerHash: string;
}[] = [
  {
    factory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
    hook: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
    locker: "0x267444d099b10fb5ed7c3cc7b7c767adca574952",
    factoryHash: "0x89a27da6f703e0a7cdd4f233e7cb57604ff75b164530962d3ff7cf8483a67d84",
    hookHash: "0xc21b1e6c1b45403e81a581f22ed6d9c747997af1cfdac1b1dc9f4b1d346a10db",
    lockerHash: "0x58455f80b3773871d601a025e56ec27c71ab3bbb8e2ca6b17828954450742025",
  },
  {
    factory: "0xd3c2280f23d813be8f9a6b5452753efff7799fd7",
    hook: "0x8e397fa55822437bca19cebfe5af9b23b09d2044",
    locker: "0x9eabd345beca72513e089bb6530d8a55de094241",
    factoryHash: "0x4991d852474dc7e3704bf385dd1a10522ab985e3e0f4839f7b8521cc7306662d",
    hookHash: "0xa53dc05f18fefec1c161482a3be4eff9b0ec98e5a802dfe60e89c620e5bdde2d",
    lockerHash: "0x58455f80b3773871d601a025e56ec27c71ab3bbb8e2ca6b17828954450742025",
  },
  {
    factory: "0x7e1eabd52ae29598e6483f72dcf1a70b14284db8",
    hook: "0x8e99d2009d60a917e9b1c00c04c077b8c0c3a044",
    locker: "0x28b6f0116c7f234951cf0e67319ed53863df2197",
    factoryHash: "0x9d6391ccd6730301cf53ea0f520b42d9f13d9dd11ba803c19ae3a01d145b7d9e",
    hookHash: "0xf9bce188c5993443713f2482642eeb4a1aa14b89bb3cea8c06c55a98de2279f0",
    lockerHash: "0xe00b76afccd77d42b82e5f705face7ffe56e292fb391e41010a6f6699ef50609",
  },
  {
    factory: "0x050e5c224466e2d377a7e555e139d51268239b39",
    hook: "0x107251ffcc1fc808643dc8da345e901f59ec2044",
    locker: "0x25679946bf7ad099079e50ffb8ae27dcc901f017",
    factoryHash: "0xb458bdf9f71b8ee41604228f9ef3b83a9ecafafc09e7983b0a39fb75707d82a0",
    hookHash: "0xf9bce188c5993443713f2482642eeb4a1aa14b89bb3cea8c06c55a98de2279f0",
    lockerHash: "0xe00b76afccd77d42b82e5f705face7ffe56e292fb391e41010a6f6699ef50609",
  },
];

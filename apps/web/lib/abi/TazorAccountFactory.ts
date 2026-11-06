export const tazorAccountFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "policyHook_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createAccount",
    "inputs": [
      {
        "name": "config",
        "type": "tuple",
        "internalType": "struct TazorAccountFactory.Config",
        "components": [
          {
            "name": "admins",
            "type": "bytes[]",
            "internalType": "bytes[]"
          },
          {
            "name": "threshold",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "executors",
            "type": "address[]",
            "internalType": "address[]"
          },
          {
            "name": "executorData",
            "type": "bytes[]",
            "internalType": "bytes[]"
          }
        ]
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "implementation",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "policyHook",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "predictAddress",
    "inputs": [
      {
        "name": "config",
        "type": "tuple",
        "internalType": "struct TazorAccountFactory.Config",
        "components": [
          {
            "name": "admins",
            "type": "bytes[]",
            "internalType": "bytes[]"
          },
          {
            "name": "threshold",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "executors",
            "type": "address[]",
            "internalType": "address[]"
          },
          {
            "name": "executorData",
            "type": "bytes[]",
            "internalType": "bytes[]"
          }
        ]
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "TazorAccountCreated",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "admins",
        "type": "bytes[]",
        "indexed": false,
        "internalType": "bytes[]"
      },
      {
        "name": "threshold",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "executors",
        "type": "address[]",
        "indexed": false,
        "internalType": "address[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "FailedDeployment",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientBalance",
    "inputs": [
      {
        "name": "balance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  }
] as const;

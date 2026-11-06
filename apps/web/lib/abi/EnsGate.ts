export const ensGateAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "portal_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "taz0rRegistry_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "paymentModule_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "l2GasLimit_",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "ROLE_APPROVER",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "forward",
    "inputs": [
      {
        "name": "label",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "auth",
        "type": "tuple",
        "internalType": "struct InvoiceAuth",
        "components": [
          {
            "name": "invoiceHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "account",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "payee",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "expiry",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "approvers",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "signatures",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "l2GasLimit",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "paymentModule",
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
    "name": "portal",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IOptimismPortal"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "taz0rRegistry",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IEnsRegistry"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "Forwarded",
    "inputs": [
      {
        "name": "label",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AccountMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadApproverList",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DuplicateApprover",
    "inputs": [
      {
        "name": "approver",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "Expired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotApprover",
    "inputs": [
      {
        "name": "approver",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnknownCompany",
    "inputs": [
      {
        "name": "label",
        "type": "string",
        "internalType": "string"
      }
    ]
  }
] as const;

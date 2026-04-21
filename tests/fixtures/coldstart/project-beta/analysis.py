"""Analysis script for project beta."""

import pandas as pd


def main() -> None:
    df = pd.read_csv("../project-alpha/results.csv")
    print(df.describe())


if __name__ == "__main__":
    main()

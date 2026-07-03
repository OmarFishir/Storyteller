import { render, fireEvent, waitFor } from "@testing-library/react-native";
import Home from "../index";
import * as api from "../../lib/api";

jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
}));

const TEMPLATES = [
  { id: "fantasy", name: "Fantasy Adventure", description: "d1", premise_seeds: ["A dragon egg hatches."] },
  { id: "noir", name: "Mystery / Noir", description: "d2", premise_seeds: ["One last case."] },
];

describe("Home", () => {
  it("renders a card per template", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText } = render(<Home />);
    await waitFor(() => expect(getByText("Fantasy Adventure")).toBeTruthy());
    expect(getByText("Mystery / Noir")).toBeTruthy();
  });

  it("tapping a seed fills the premise input", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByPlaceholderText } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.press(getByText("A dragon egg hatches."));
    expect(getByPlaceholderText(/premise/i).props.value).toBe("A dragon egg hatches.");
  });

  it("shows a retry state when templates fail to load", async () => {
    jest.spyOn(api, "getTemplates").mockRejectedValue(new Error("down"));
    const { getByText } = render(<Home />);
    await waitFor(() => expect(getByText(/tap to retry/i)).toBeTruthy());
  });

  it("passes the chosen length to the story route", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByPlaceholderText } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.changeText(getByPlaceholderText(/premise/i), "a premise");
    fireEvent.press(getByText(/^Long$/));
    fireEvent.press(getByText(/begin the story/i));
    const { router } = require("expo-router");
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/story",
      params: { templateId: "fantasy", premise: "a premise", length: "long" },
    });
  });
});
